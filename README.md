# Cleanify

Clean up your Spotify playlists by swiping through them like a crate of records.
Swipe right (or press →) to keep a song. Swipe left (or press ←) to remove it from
the playlist straight away. **Undo** (or Backspace) puts the last removed song back
where it was, and the **bargain bin** lists every removed song with a *Put back* button.

Address: https://cleanify.szy.monster/

## How it works

- A static page (`index.html`, `style.css`, `app.js`) with no build step.
- Spotify sign-in uses PKCE in the browser, so there's no secret anywhere.
- Each person uses their own free Spotify developer app: the sign-in screen walks
  through making one and pasting its Client ID (Spotify caps an app in development
  mode at 5 users).
- Only playlists you made or collaborate on are listed, because Spotify won't let
  apps change other people's playlists.
- By default it saves a private "(backup)" copy of a playlist the first time you clean it.
- ▶ plays the song on the device picked under **Play on** (remembered): one of your
  Spotify apps or speakers, or **This browser** (Spotify's Web Playback SDK; not Firefox/Zen).
  Needs Premium. Autoplay plays each new card.
- What you've kept, removed and can undo is remembered per playlist in this browser.

## Spotify app settings

Add these Redirect URIs to your Spotify app and tick **Web API** and **Web Playback SDK**:

- `https://cleanify.szy.monster/`
- `http://127.0.0.1:8000/` (to run it on your PC)

## Run it on your PC

Double-click `run-local.bat` (needs Python), or run `python -m http.server 8000 --bind 127.0.0.1`
and open http://127.0.0.1:8000/.

## Hosting (Cloudflare Workers)

Connect this repo in Cloudflare (Workers & Pages > Create > Import a repository),
with deploy command `npx wrangler deploy`. `wrangler.jsonc` serves the folder as a
static site. Then add the custom domain `cleanify.szy.monster` under the Worker's
Domains & Routes.
