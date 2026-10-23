import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function sseFrame(event: Record<string, unknown>): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: CORS_HEADERS });
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return new Response("Missing Authorization header", { status: 401, headers: CORS_HEADERS });
  }

  let body: { message?: string; context?: Record<string, unknown> };
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON body", { status: 400, headers: CORS_HEADERS });
  }
  const message = (body.message || "").trim();
  const context = body.context || {};
  if (!message) {
    return new Response("Empty message", { status: 400, headers: CORS_HEADERS });
  }

  // Scoped as the calling user -- RPC calls below run under their own
  // identity, so is_admin()/can_edit() checks inside those Postgres
  // functions behave exactly as they do for the existing app.
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });

  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      const send = (event: Record<string, unknown>) => controller.enqueue(enc.encode(sseFrame(event)));

      try {
        // ai_build_context checks the caller is an admin (it raises otherwise) and builds the prompt
        const { data: ctx, error: ctxError } = await supabase.rpc("ai_build_context", {
          p_message: message,
          p_context: context,
        });
        if (ctxError) throw new Error(ctxError.message);
        // The Anthropic key is read here with the server's own credentials, never handed to the browser:
        // ai_build_context no longer returns it, so an admin can't call that function directly and take the key.
        let apiKey: string = ctx.api_key || "";
        if (!apiKey) {
          const svc = createClient(SUPABASE_URL, SERVICE_KEY);
          const { data: k } = await svc.from("private_config").select("value").eq("key", "anthropic_api_key").maybeSingle();
          apiKey = (k?.value as string) || "";
        }
        if (!apiKey) {
          send({ type: "error", message: "No Claude API key saved yet -- add one in the founder AI tab." });
          controller.close();
          return;
        }

        const model: string = ctx.model;
        const effort: string = ctx.effort;
        const systemPrompt: string = ctx.system_prompt;
        const tools = ctx.tools;
        // deno-lint-ignore no-explicit-any
        let msgs: any[] = ctx.messages;

        let finalText = "";
        // Everything the assistant said across all of its steps, and whether it offered action buttons.
        // A turn that only calls suggest_actions has no text of its own, so the saved reply must come from earlier text.
        let allText = "";
        let sentActions = false;
        let iterations = 0;

        while (true) {
          iterations++;
          if (iterations > 5) {
            const errText = "Error: the assistant made too many tool calls without answering -- try rephrasing your question.";
            await supabase.rpc("ai_finish_turn", { p_reply: errText });
            send({ type: "text_delta", text: errText });
            send({ type: "done" });
            controller.close();
            return;
          }

          send({ type: "status", phase: "thinking" });

          const anthropicBody: Record<string, unknown> = {
            model,
            max_tokens: 1536,
            system: systemPrompt,
            messages: msgs,
            tools,
            stream: true,
          };
          if (model !== "claude-haiku-4-5") {
            anthropicBody.output_config = { effort };
          }

          const anthRes = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
              "x-api-key": apiKey,
              "anthropic-version": "2023-06-01",
              "content-type": "application/json",
            },
            body: JSON.stringify(anthropicBody),
          });

          if (!anthRes.ok || !anthRes.body) {
            const errBody = await anthRes.text().catch(() => "");
            let errMsg = `Anthropic returned status ${anthRes.status}`;
            try { errMsg = JSON.parse(errBody)?.error?.message || errMsg; } catch { /* ignore */ }
            await supabase.rpc("ai_finish_turn", { p_reply: "Error: " + errMsg });
            send({ type: "text_delta", text: "Error: " + errMsg });
            send({ type: "done" });
            controller.close();
            return;
          }

          const reader = anthRes.body.getReader();
          const decoder = new TextDecoder();
          let buf = "";
          // deno-lint-ignore no-explicit-any
          const contentBlocks: any[] = [];
          let stopReason: string | null = null;
          let turnText = "";
          // Token usage for this one Claude response: input arrives in message_start,
          // output grows through message_delta (cumulative).
          let inputTokens = 0;
          let outputTokens = 0;

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            const lines = buf.split("\n");
            buf = lines.pop() || "";
            for (const line of lines) {
              if (!line.startsWith("data: ")) continue;
              const dataStr = line.slice(6).trim();
              if (!dataStr || dataStr === "[DONE]") continue;
              let evt: Record<string, unknown>;
              try { evt = JSON.parse(dataStr); } catch { continue; }

              if (evt.type === "message_start") {
                // deno-lint-ignore no-explicit-any
                const u: any = (evt.message as any)?.usage;
                if (u) {
                  inputTokens = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
                  outputTokens = u.output_tokens || 0;
                }
              } else if (evt.type === "content_block_start") {
                // deno-lint-ignore no-explicit-any
                const block: any = evt.content_block;
                const idx = evt.index as number;
                contentBlocks[idx] = block.type === "tool_use"
                  ? { type: "tool_use", id: block.id, name: block.name, inputJson: "" }
                  : block.type === "text"
                  ? { type: "text", text: "" }
                  : { type: block.type };
                if (block.type === "tool_use") {
                  send({ type: "status", phase: "tool_start", tool: block.name });
                }
              } else if (evt.type === "content_block_delta") {
                const idx = evt.index as number;
                // deno-lint-ignore no-explicit-any
                const delta: any = evt.delta;
                if (delta.type === "text_delta") {
                  contentBlocks[idx].text += delta.text;
                  turnText += delta.text;
                  send({ type: "text_delta", text: delta.text });
                } else if (delta.type === "input_json_delta") {
                  contentBlocks[idx].inputJson += delta.partial_json;
                }
              } else if (evt.type === "message_delta") {
                // deno-lint-ignore no-explicit-any
                stopReason = (evt.delta as any)?.stop_reason || stopReason;
                // deno-lint-ignore no-explicit-any
                const u: any = (evt as any).usage;
                if (u && typeof u.output_tokens === "number") outputTokens = u.output_tokens;
              }
            }
          }

          // Meter this response. A metering hiccup must never break the chat itself.
          try {
            const { data: usage } = await supabase.rpc("ai_record_usage", {
              p_model: model,
              p_input: inputTokens,
              p_output: outputTokens,
            });
            if (usage) send({ type: "usage", ...usage });
          } catch { /* ignore */ }

          // deno-lint-ignore no-explicit-any
          const finishedBlocks: any[] = contentBlocks.filter(Boolean).map((b) => {
            if (b.type === "tool_use") {
              let input = {};
              try { input = JSON.parse(b.inputJson || "{}"); } catch { /* leave empty */ }
              return { type: "tool_use", id: b.id, name: b.name, input };
            }
            if (b.type === "text") return { type: "text", text: b.text };
            return b;
          });

          if (turnText.trim()) allText += (allText ? "\n\n" : "") + turnText;

          if (stopReason !== "tool_use") {
            finalText = allText || (sentActions ? "Here are the options. Pick one of the suggested actions." : "(empty reply)");
            await supabase.rpc("ai_finish_turn", { p_reply: finalText });
            send({ type: "done" });
            controller.close();
            return;
          }

          msgs = [...msgs, { role: "assistant", content: finishedBlocks }];

          // deno-lint-ignore no-explicit-any
          const toolResults: any[] = [];
          for (const block of finishedBlocks) {
            if (block.type !== "tool_use") continue;

            if (block.name === "suggest_actions") {
              const actions = (block.input as { actions?: unknown[] })?.actions || [];
              if (actions.length) sentActions = true;
              send({ type: "actions", actions });
              toolResults.push({
                type: "tool_result",
                tool_use_id: block.id,
                content: JSON.stringify({ ok: true }),
              });
              continue;
            }

            const { data: toolResult, error: toolError } = await supabase.rpc("ai_run_tool", {
              p_name: block.name,
              p_input: block.input,
            });
            const result = toolError ? { error: toolError.message } : toolResult;
            send({ type: "tool_result", tool: block.name, input: block.input, result });
            toolResults.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: JSON.stringify(result),
            });
          }

          msgs = [...msgs, { role: "user", content: toolResults }];
        }
      } catch (e) {
        send({ type: "error", message: e instanceof Error ? e.message : String(e) });
      } finally {
        try { controller.close(); } catch { /* already closed */ }
      }
    },
  });

  return new Response(stream, {
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
});
