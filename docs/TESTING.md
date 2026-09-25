# Manual test script

Automated coverage: `npm test` runs the unit tests (`tests/unit`) and a headless Playwright
smoke test (`tests/e2e/smoke.mjs`). This page covers what has to be checked by hand on a real
phone: audio output, autoplay, Add to Home Screen and offline playback.

Live URL: **https://mattkleinsmith.github.io/chinese-audio-flashcards/**
(Pages has to be switched on once first; see the README.)

For local testing on a phone on the same Wi-Fi, run `npm run serve` and open
`http://<your-computer-ip>:8080`. Service workers need HTTPS or localhost, so the offline
steps only work on the Pages URL or on localhost.

## 1. First run (phone: iOS Safari or Android Chrome)

1. Open the live URL. You should see **听力卡 Listening Cards** and an empty state with two buttons:
   *Import from Hack Chinese* and *Quick start with HSK levels*.
2. The page should not scroll sideways, and every button should be easy to hit with a thumb.
3. Switch the phone to dark mode. The app should switch to dark colours.

## 2. Add to Home Screen

1. iOS: Share → *Add to Home Screen*. Android: ⋮ → *Install app* / *Add to Home screen*.
2. Launch it from the home screen icon. It should open full-screen, with no browser bar.

## 3. Import a Hack Chinese export

1. In Hack Chinese, open a list → *List Options* (⋮) → *Export*. Save the file to the phone
   (Files / Downloads).
2. In the app: *Import from Hack Chinese* → *Choose files…* → pick the export (you can pick
   several).
3. Check the preview:
   - The first 20 words show up with sensible Hanzi / Pinyin / Definition columns.
   - If a column is wrong, change it with the *Simplified / Traditional / Pinyin / Definition*
     dropdowns. The table should update straight away.
   - The report line shows how many words were found, any duplicates, and how many have no audio.
4. Tap **Import N words**. A toast should say *Added N words · M have audio · K sentences unlocked*.
5. Import the same file again. It should add **0** words (imports are additive and idempotent).
6. Optional: paste a few words into the text box (one per line, or copied from a spreadsheet)
   and import them the same way.

No export file? Use *Quick start with HSK levels*: tick HSK 1 (and 2), then tap *Add selected levels*.

## 4. Study words

1. Home → **Words** tile → **Start**.
2. The clip should **play by itself** straight away. If the phone blocks autoplay, the button
   says *Tap to play*. Tap it and the clip plays.
3. Check the front of the card. It must show **only** the label "Word", a round Play/Pause
   button, a row of transport buttons (↺, −5s, −1s, −.5s, −.1s) and a row of speed chips
   (0.25× to 1.5×). There must be **no** duration, timer, seek bar, progress line or waveform.
   The counter at the top counts cards (e.g. `0/20`), not seconds.
4. Transport checks, best done on a sentence card:
   - Tap the big button while a clip plays: it pauses and says *Paused*. Tap again: it resumes
     from where it stopped, not from the beginning.
   - Tap −1s a few times quickly while playing: the audio jumps back each tap and keeps playing.
     Tap −.1s repeatedly: small, precise steps. Tapping past the start just holds at the start.
   - Pause, tap −5s, then resume: playback continues from the earlier point.
   - Tap ↺: the clip restarts from the beginning.
   - Tap 0.5× then 1.25×: the tempo changes but the voice keeps its pitch. Leave the app and
     come back: the chosen speed is remembered (it is also in Settings).
5. Tap **Show answer**, or tap anywhere on the lower half of the card. Check the back:
   - large Hanzi
   - tone-coloured pinyin in the Pleco / Hack Chinese scheme (1 red, 2 green, 3 blue, 4 purple, neutral grey)
   - up to 3 definitions
   - an HSK badge
6. The transport controls stay on the back (smaller). Pause, rewind and speed still work.
7. Grade with Again / Hard / Good / Easy. Each button shows its next interval (e.g. `1m`,
   `10m`, `4d`). Press **Again** on one card: it comes back 3–6 cards later in the same session.
8. Try the ≡ menu: *Skip*, *Suspend card*, *Report bad audio*. Each one moves on to the next card.
9. Close the app completely, then reopen it. The Home counts should show the progress you made:
   cards graded Good are due again later today (10-minute step), and the new count drops.

## 5. Study sentences

1. Home → **Sentences** → **Start**. The front label reads "Sentence · female" or
   "Sentence · male". Nothing on the front gives away the text.
2. If the tile says 0 new and 0 due, go to Settings → *Unknown words allowed per sentence* → 1 or 2.
3. Reveal the answer. The sentence is split into words, with each character's pinyin
   underneath. Words not in your vocab have a dotted underline.
4. Tap a word to open a popover with its definition, or "no definition". Tap **+ Add to vocab**
   on an unknown word: the underline goes away and the word is now in Vocabulary.

## 6. Offline

1. Play at least 5–10 cards while online. The next few cards' clips are downloaded ahead of time.
2. Turn on **airplane mode**.
3. Reopen the app from the home screen icon. It should load, and the cards you have already
   played (plus the pre-fetched ones) should still play.
4. Clips that were never cached will not play offline. That is expected: the Play button
   shows *Audio failed · tap to retry*, and the app does not crash.
5. Turn airplane mode off again.

## 7. Settings, backup and restore

1. Settings: toggle *Autoplay*, *Tone colours*, *Show traditional* and *Show definition*, then
   start a session and check that each toggle takes effect. *Playback speed 0.85×* is marked
   "not natural speed".
2. **Export everything**. A file named `clf-backup-YYYYMMDD.json` is downloaded.
3. **Delete all data**, then confirm. The app returns to the empty state.
4. **Restore…** → pick the backup → confirm. Vocab and progress are back.
5. About should list the audio sources with their licences and links (audio-cmn CC BY-SA 4.0,
   AISHELL-3 Apache-2.0, CC-CEDICT CC BY-SA 4.0), the app version (short git SHA on Pages;
   `dev` locally) and the audio bundle build date.

## 8. Vocabulary screen

1. Open ☰ Vocabulary. Search by Hanzi (`学`), by pinyin without tones (`xuexi`), and by English
   (`library`).
2. The filter chips *All / No audio / Suspended* work.
3. Delete one word with ✕ or a long-press. *Delete HSK quick-add* removes only the HSK words.
