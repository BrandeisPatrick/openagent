---
name: summarize-page
description: Open a URL in the built-in browser and summarize it. Usage: /summarize-page <url>
---
Summarize the web page at the URL the user gave.

1. browser_navigate to the URL.
2. browser_get_text to read it. If the text is mostly navigation or a cookie banner, browser_read_page and click through to the main content first.
3. Write a summary of at most five bullet points, then one sentence on who the page is for.
4. Quote nothing longer than a short phrase. Mention the page title and URL at the top.
