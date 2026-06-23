# Privacy Policy

**Last updated:** June 23, 2026  
**Publisher:** Qwenzyy  
**Contact:** floresaybaez574@gmail.com

---

## 1. Overview

Qwin Video Downloader ("the Extension") is a browser extension that detects video URLs on web pages and sends them to a local Python helper on your machine for downloading. This Privacy Policy explains what data the Extension does and does not collect.

**We do not collect, transmit, or sell any personal data.**

## 2. No External Data Collection

Qwin Video Downloader does **not** collect, transmit, or share any of the following to any external server:

- Personal information (name, email address, IP address, etc.)
- Browsing history or browsing activity
- Downloaded content or file names
- Page URLs or video URLs
- Usage analytics or telemetry
- Any other user data

## 3. Local Storage Only

The Extension stores the following data **locally on your machine** using the browser's built-in storage APIs (`chrome.storage.local` or equivalent):

- **Download history** — a record of your past downloads (URLs, file names, timestamps) for display in the Extension's download list
- **Settings** — your preferences such as custom download folder and quality settings
- **Cached filter lists** — uBlock Origin filter patterns used for ad/video URL classification

**This data never leaves your machine.** It is stored only in your browser's local storage and is accessible only to the Extension running on your browser. You can clear this data at any time through your browser's extension settings or by removing and reinstalling the Extension.

## 4. Native Host Communication

The Extension communicates exclusively with a local Python process ("native host") running on the same machine. This communication occurs through the browser's native messaging API. **No data is sent over the network by the Extension or the native host** as part of this communication.

The native host may, on your instruction, download content from URLs you have selected. These downloads are made from your machine directly to the content source (e.g., a video hosting CDN), exactly as your browser would when playing a video. The native host does not transmit any data to Qwenzyy or any third party controlled by Qwenzyy.

## 5. Third-Party Services

The Extension does **not** embed any third-party analytics, tracking, advertising, or analytics SDKs. The Extension does not load any external resources or make any network requests to third-party servers for its core functionality.

The native host uses open-source tools (`yt-dlp`, `ffmpeg`, `aria2c`) which may make network requests to the content sources you specify. These tools operate under their own licenses and privacy practices.

## 6. Data Retention

Since no personal data is collected or transmitted to any external server, no data retention policy is applicable. Locally stored data (download history, settings, cached filters) is retained in your browser's local storage until you choose to clear it.

## 7. Children's Privacy

The Extension is not directed at children under the age of 13 (or 16 in the European Union). We do not knowingly collect any personal information from children. If you believe a child has provided personal data through the Extension, please contact us, and we will take steps to remove that data.

## 8. Changes to This Policy

We may update this Privacy Policy from time to time. Material changes will be communicated through the Extension's documentation or repository. Your continued use of the Extension after any changes constitutes your acceptance of the updated policy.

## 9. Contact

If you have any questions about this Privacy Policy, please contact:

**Email:** floresaybaez574@gmail.com

---

*This document is for informational purposes and does not constitute legal advice.*
