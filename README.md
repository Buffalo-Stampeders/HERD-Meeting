# HERD Meeting — Video Training Course

Gated video training: learners enter name + email, watch each video segment, and must answer the multiple-choice questions to advance. Every attempt is logged to a Google Sheet.

| File | Purpose |
|---|---|
| `course.html` | Learner-facing course. Embed this on the website. Loads its content live from the backend. |
| `admin.html` | Password-protected dashboard to edit modules, videos, questions and answers, view submissions, and export CSV. |
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
