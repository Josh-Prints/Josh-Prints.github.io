# Dune for iOS

The website's Dune game as an iPhone/iPad app. `Sources/App.swift` shows the game full screen in a web
view, served from a copy of `dune.html` (and the site scripts it uses) bundled inside the app, so it
plays offline. Sign-in by email code and the leaderboard use the website's database when online;
Google sign-in is hidden because Google blocks it inside apps.

The GitHub workflow `.github/workflows/dune-ios.yml` builds an **unsigned** `Dune.ipa` on a macOS runner
whenever `dune.html`, the shared site files or this folder change on `main` (or when run by hand), and
attaches it to the `dune-ios` GitHub release. An unsigned .ipa has to be signed when it's installed:
sideload it with AltStore, SideStore or Sideloadly (they sign it with your Apple ID), or install it
with TrollStore.
