# Amrita-TLP-Course_Feedback-Completer

A userscript that fills in the Amrita student portal's **Course Feedback** and **Class TLP Feedback** forms for you. It answers every question, clicks through to Finish, and stops at the OTP step so you only have to paste the code from your email.

## What it does

- **Course Feedback** (`/client/course-feedback-list`): runs in a single tab. It opens each unfinished course, answers every question, clicks Finish, goes back to the list and moves on to the next course. The portal asks for an OTP only once here.
- **Class TLP Feedback** (`/client/class-feedback`): the portal wants an OTP for every subject, so the script opens one background tab per subject. Tabs fill one at a time, because the portal handles one request per login and parallel tabs just cause 504s. Each tab stops at its OTP, and then the next one starts.
- Every question gets **Strongly Agree**, or option 1 if a question doesn't offer that. Any text box gets "Good course".
- Server errors (504, timeouts and so on) are retried until the page loads, and a save that failed is done again.
- Once you paste the OTP, the script clicks **Validate & Finish** for you.
- A small panel in the bottom-right corner shows what it's doing and has a **Pause / Resume** button that applies to every tab.

## Install

1. Install a userscript manager: [Tampermonkey](https://www.tampermonkey.net/) (Chrome, Edge, Firefox, Safari) or [Violentmonkey](https://violentmonkey.github.io/).
2. Open [`amrita-feedback-autofill.user.js`](amrita-feedback-autofill.user.js) and click **Raw**. Tampermonkey will offer to install it. You can also create a new script in the Tampermonkey dashboard and paste the file's contents in.
3. In Chrome you may need to turn on **Developer mode** in `chrome://extensions` (or "Allow user scripts" for Tampermonkey) before userscripts will run.

## Use

1. Log in to [students.amrita.edu](https://students.amrita.edu).
2. Open the **Course Feedback** list or the **Class TLP Feedback** list.
3. Let it run.
   - **Course Feedback:** when it asks for the OTP, click **SEND OTP** and paste the code from your Amrita email. It carries on by itself after that.
   - **Class TLP:** tabs titled "🔐 Enter OTP" are waiting for you. In each one, click **SEND OTP** and paste the code. Do them one at a time, since a new OTP can cancel the previous one.
4. When a tab shows "✅ Submitted", you can close it.

If something gets stuck, click **Pause auto-fill** and then **Resume auto-fill**. Resuming clears the script's saved progress and reloads the page.

## Settings

The settings are constants at the top of the script:

| Setting | Default | What it does |
| --- | --- | --- |
| `ANSWER` | `'Strongly Agree'` | The option to pick for each question. Falls back to option 1 if it isn't there. |
| `COMMENT` | `'Good course'` | Text for any comment box. |
| `OPEN_TABS` | `true` | Open unfinished items automatically from a list page. |
| `GO_TO_OTP` | `true` | After the last question, go to Finish and stop at the OTP. |
| `AUTO_SEND_OTP` | `false` | Click SEND OTP automatically. Leave it off when several tabs are open, since a new OTP may cancel the previous one. |
| `DELAY_MS` | `700` | Pause before each click or page load. Raise it if the portal is slow. |
| `MAX_VISITS_PER_QUESTION` | `10` | Give up on a question that won't save after this many tries. |
| `RETRY_MIN_S` / `RETRY_MAX_S` | `5` / `30` | Retry delay after a server error. It starts at 5s and doubles up to 30s. |
| `PAGE_WATCHDOG_S` | `90` | Reload a page that's still hanging after this many seconds. |

## Notes

- You still enter every OTP yourself. The script never reads your email.
- It only runs on `https://students.amrita.edu/client/*`.
- If the portal's layout changes, the script may stop finding buttons. Check the browser console for `[feedback-autofill]` messages.
