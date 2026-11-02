# HERD Meeting — Video Training Course

Gated video training: learners enter name + email, watch each video segment, and must answer the multiple-choice questions to advance. Every attempt is logged to a Google Sheet.

| File | Purpose |
|---|---|
| `course.html` | Learner-facing course. Embed this on the website. Loads its content live from the backend. |
| `admin.html` | Password-protected dashboard to edit modules, videos, questions and answers, view submissions, and export CSV. |

## Section types

A section is a **video module**, a **photo module** (one image or a slideshow — learners click to enlarge), or a **text-only section** (a header plus rich text). Any kind can carry quiz questions or be set to "No questions" so the learner just clicks Continue. A video module may be published without a video; a placeholder image (or a branded "coming soon" card) shows until one is added.

## End-of-course review

After the last section, learners rate the meeting 1–5 (required) and can leave a comment (optional). Reviews are saved to a separate **Reviews** sheet and summarized on the dashboard's Submissions tab (average, distribution, comments, CSV). Turn it off or change the wording in the dashboard's Course settings.

## Languages and captions

Learners choose a language from a menu on the course; the choice is remembered and logged with each submission. English is the source language.

- **Translations tab (admin):** tick the languages to offer, then **Translate new & changed**. Text is machine-translated with Google Translate (built into Apps Script — no API key). Every line can be edited; edited lines are marked *Reviewed* and are never overwritten by re-translation. When the English changes, the translation is flagged *Outdated* and learners see the English until it is re-translated. Publishing offers to translate anything new or outdated first.
- **Captions:** each video module accepts English captions as a `.vtt` or `.srt` file (Vimeo and YouTube can both export these from their auto-captions). Captions are translated line by line with the original timings. MP4, Dropbox and Drive (locked player) videos show them as native subtitles; YouTube and Vimeo show them as an overlay with CC and full-screen buttons. Drive-player and BoxCast embeds cannot show captions.

## Images

Images uploaded in the dashboard are stored in a Google Drive folder named "<Sheet name> Images" next to the spreadsheet, shared read-only by link, and resized to a max of 1800px before upload. You can also reference any image by URL.

## Video sources and playback lock

| Source | Full-watch gate | Playback lock (1x, no skipping) |
|---|---|---|
| MP4/MOV file URL | ✓ | ✓ |
| YouTube | ✓ | ✓ |
| Vimeo (speed menu removed entirely when locked; set embed privacy to your domains in Vimeo) | ✓ | ✓ |
| Dropbox share link — streamed through our player; MP4, any size, shared "Anyone with the link" | ✓ | ✓ |
| Google Drive (locked player) — streams the file through our player; MP4 only, **under 100 MB**, shared "Anyone with the link" | ✓ | ✓ |
| Google Drive (Drive player) — any size | ✗ | ✗ |
| BoxCast embed | ✗ | ✗ |

"Lock playback" is a course-level setting (on by default). The dashboard checks Drive files against the account and warns when one is too large, not an MP4, or not shared publicly; a locked-player module over 100 MB is blocked from publishing. For long recordings, unlisted YouTube is the reliable way to keep the lock. Each module can also carry optional notes shown under the video, either always visible or behind a "Show notes" toggle.
| `apps-script.gs` | Google Apps Script backend (bound to the Google Sheet). Stores the course config and logs submissions. |

## Live pages (GitHub Pages)

- Course: `https://buffalo-stampeders.github.io/HERD-Meeting/course.html`
- Admin: `https://buffalo-stampeders.github.io/HERD-Meeting/admin.html`

## Embed on the website

```html
<iframe src="https://buffalo-stampeders.github.io/HERD-Meeting/course.html"
        style="width:100%;height:900px;border:0;" allowfullscreen></iframe>
```

## Editing course content

Open `admin.html`, sign in with the admin password, edit, use **Preview course** to check, then **Publish changes**. Learners see the new version on their next page load — no code change or commit needed.

## Changing the code / styling

Edit the HTML files and push to `main`. GitHub Pages redeploys within about a minute.

## Backend changes

After editing `apps-script.gs` in the Apps Script editor: **Deploy → Manage deployments → ✎ → Version: New version → Deploy.** The URL stays the same.
