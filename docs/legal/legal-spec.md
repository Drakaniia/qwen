# Legal Documentation — Specification

**Project:** Qwin Video Downloader
**Author:** Qwenzyy
**Status:** Draft spec — pending implementation
**Last updated:** 2026-06-23

---

## 1. Overview

Qwin Video Downloader is a browser extension (Chrome, Firefox, Yandex) that detects video URLs on a page and sends them to a local Python native host helper. The helper uses `yt-dlp`, `ffmpeg`, and `aria2c` to download videos. It also supports BitTorrent (magnet/.torrent), Widevine CDM decryption, screen recording, CDP-based extraction, and uBlock Origin filter list integration.

Before making the repository public, the project needs a suite of legal documents to:
- Limit liability for how users employ the tool
- Comply with DMCA safe-harbor requirements
- Clarify data handling (or lack thereof)
- Define acceptable use
- Protect the developer from legal claims arising from user actions

---

## 2. Document List

Six files total, all under `docs/`:

| # | File | Purpose |
|---|------|---------|
| 1 | `docs/legal/terms-of-service.md` | End-user license agreement — binding terms for using Qwin |
| 2 | `docs/legal/privacy-policy.md` | What data is / is not collected, stored, or shared |
| 3 | `docs/legal/dmca-notice.md` | DMCA takedown procedure for copyright holders |
| 4 | `docs/legal/disclaimer.md` | "As-is" warranty disclaimer, limitation of liability |
| 5 | `docs/legal/fair-use-notice.md` | Educational statement about fair use and user responsibility |
| 6 | `LICENSE` | GPL-3.0 license file (project root) |

### 2.1 Update existing file

- `docs/README.md` — add links to all 5 new legal documents in the documentation index

---

## 3. File-by-File Requirements

### 3.1 `docs/legal/terms-of-service.md`

**Purpose:** Define the contractual relationship between the developer ("Qwenzyy") and the user.

**Must include:**
- **Acceptance:** Using Qwin implies acceptance of these terms
- **License Grant:** Personal, non-commercial, non-transferable, revocable license to use the extension
- **Acceptable Use — Explicit Prohibitions:**
  - Downloading copyrighted content without permission from the rights holder
  - Using Qwin to violate any applicable local, national, or international law
  - Circumventing technological protection measures (TPMs) where prohibited by law
  - Using Qwin for any unlawful, abusive, or fraudulent purpose
- **User Responsibility:** Users must ensure they have the legal right to download any content they capture. Users are solely responsible for their own actions.
- **Third-Party Platforms:** Acknowledgment that downloading from YouTube, TikTok, Instagram, X (Twitter), or similar platforms may violate those platforms' Terms of Service. The developer is not affiliated with any of these platforms.
- **Intellectual Property:** Users retain no rights to downloaded content beyond what copyright law permits
- **Indemnification:** User agrees to indemnify and hold harmless the developer from any claims arising from the user's misuse of the software
- **Disclaimer of Warranties:** Software provided "as is" without warranty
- **Limitation of Liability:** Developer not liable for any damages arising from use
- **Termination:** Developer may terminate access for any violation
- **Governing Law:** No specific jurisdiction stated — generic language

### 3.2 `docs/legal/privacy-policy.md`

**Purpose:** Disclose exactly what data Qwin does and does not collect.

**Must include:**
- **No External Data Collection:** Qwin does not collect, transmit, or sell any personal data, browsing history, downloaded content, or usage analytics to any external server
- **Local Storage Only:**
  - Download history, settings, and cached filter lists are stored locally in the browser's `chrome.storage.local` (or equivalent)
  - This data never leaves the user's machine
  - Users can clear this data at any time via browser settings or extension controls
- **Native Host Communication:** The extension communicates exclusively with a local Python process running on the same machine. No data is sent over the network by Qwin itself.
- **Third-Party Services:** The extension does not embed any third-party analytics, tracking, or advertising SDKs
- **Data Retention:** No data retention policy needed — no data leaves the local machine
- **Children's Privacy:** Not directed at children under 13 (or 16 in EU)
- **Changes:** Policy may be updated; continued use constitutes acceptance
- **Contact:** floresaybaez574@gmail.com

### 3.3 `docs/legal/dmca-notice.md`

**Purpose:** Provide a mechanism for copyright holders to report alleged infringement, in compliance with the Digital Millennium Copyright Act (DMCA) Section 512.

**Must include:**
- **Designated Agent Contact:** floresaybaez574@gmail.com (email only)
- **Identification of copyrighted work** — what the claimant must provide
- **Identification of infringing material** — what the claimant must describe
- **Statement of good faith belief** — required statement language
- **Statement of accuracy under penalty of perjury** — required statement language
- **Signature requirement** — physical or electronic signature
- **Counter-notification procedure** — how an affected user can respond
- **Repeat infringer policy** — termination for repeat infringers
- **Limitation of liability:** Qwin is a tool; the DMCA process applies to how the tool is represented/used

### 3.4 `docs/legal/disclaimer.md`

**Purpose:** Broad legal disclaimer covering warranties, liabilities, and third-party affiliations.

**Must include:**
- **"As-Is" Warranty Disclaimer:** Software provided without any warranty, express or implied
- **No Affiliation:** Qwin is not affiliated with, endorsed by, or connected to YouTube, Google, TikTok, Instagram, X (Twitter), Meta, or any other video platform
- **No Hosting:** Qwin does not host, store, or distribute any copyrighted content. It is a local tool that downloads content the user already has access to in their browser.
- **No Legal Advice:** The developer is not providing legal advice
- **User Responsibility:** Users are solely responsible for determining the legality of their downloads in their jurisdiction
- **Service Availability:** No guarantee that the tool will work with any specific website or video format
- **Limitation of Liability:** Developer not liable for direct, indirect, incidental, or consequential damages
- **External Links:** Not responsible for content of third-party websites linked from documentation

### 3.5 `docs/legal/fair-use-notice.md`

**Purpose:** Educate users about copyright law and fair use principles without being legal advice.

**Must include:**
- **What is Fair Use:** Brief explanation of the four fair use factors (purpose, nature, amount, effect)
- **Personal Use:** Downloading for personal, non-commercial use may be considered fair use in some jurisdictions, but users should consult a lawyer
- **Not Legal Advice:** Explicitly state this is not legal advice
- **Jurisdiction Variance:** Fair use is a US doctrine; other countries have different rules (fair dealing, etc.)
- **Responsibility:** Users should only download content they own, have a license for, or that is in the public domain
- **Recommendation:** When in doubt, seek permission from the copyright holder

### 3.6 `LICENSE` (GPL-3.0)

**Requirements:**
- Standard GPL-3.0 license text
- Copyright line: `Copyright (C) 2026 Qwenzyy`
- Placed at project root as `LICENSE`

---

## 4. Naming Convention

All legal document files use **kebab-case** to match the existing `docs/` convention:

```
docs/legal/
├── terms-of-service.md
├── privacy-policy.md
├── dmca-notice.md
├── disclaimer.md
├── fair-use-notice.md
```

---

## 5. Update `docs/README.md`

Add the following section to the documentation index:

```markdown
## Legal

- [Terms of Service](legal/terms-of-service.md) — License terms, acceptable use, and user responsibilities
- [Privacy Policy](legal/privacy-policy.md) — Data collection and storage practices
- [DMCA Notice](legal/dmca-notice.md) — Copyright infringement takedown procedure
- [Disclaimer](legal/disclaimer.md) — Warranty disclaimer and limitation of liability
- [Fair Use Notice](legal/fair-use-notice.md) — Guidance on copyright and fair use
```

---

## 6. Content Guidelines

### 6.1 Tone
- Professional, clear, and direct
- Avoid overly aggressive or accusatory language (e.g., "you must not steal" → "you agree not to use this software to download content you do not have the legal right to access")
- Written at a reading level accessible to non-lawyers

### 6.2 Platform References
- YouTube may be named explicitly as a supported platform for detection/downloading
- Other platforms (TikTok, Instagram, X/Twitter, etc.) may be mentioned generically or by name as needed
- All mentions should include a disclaimer of affiliation

### 6.3 Publisher Identity
- All documents refer to the publisher as **Qwenzyy**
- Contact email: **floresaybaez574@gmail.com**
- No physical address included

### 6.4 Jurisdiction
- No specific jurisdiction or governing law specified
- DMCA language used for copyright procedures (as a standard), but governing law clause should remain generic

---

## 7. Implementation Checklist

- [ ] Write `docs/terms-of-service.md`
- [ ] Write `docs/privacy-policy.md`
- [ ] Write `docs/dmca-notice.md`
- [ ] Write `docs/disclaimer.md`
- [ ] Write `docs/fair-use-notice.md`
- [ ] Write `LICENSE` (GPL-3.0) at project root
- [ ] Update `docs/README.md` with links to all legal documents
- [ ] Final review — ensure no broken links, consistent tone, complete content

---

## 8. Appendix: Legal Context (Non-Binding Research Notes)

Based on research into legal documents used by similar tools (Video DownloadHelper, SaveFrom.net, Y2Mate, etc.):

- **Common structure:** ToS → Privacy → DMCA → Disclaimer → Fair Use is a standard package
- **Key liability shift:** The "user responsibility + indemnification" combination is the primary legal defense strategy
- **Platform naming:** Many tools avoid naming specific platforms; however, since Qwin's README and documentation already mention YouTube, listing it explicitly is more transparent
- **DMCA applicability:** Qwin is a tool, not a hosting service, so standard DMCA safe-harbor (Section 512) may not directly apply — but having a takedown procedure demonstrates good-faith compliance
- **Disclaimer effectiveness:** Legal experts note that disclaimers cannot override the law, but they serve as a deterrent and satisfy platform requirements (Chrome Web Store, GitHub, etc.)
- **GPL-3.0 note:** If the code is GPL-3.0, anyone who distributes the software (including modified versions) must also make their source available under GPL-3.0. The legal documents (ToS, Privacy, etc.) are not part of the source code license — they govern usage of the software as a service/tool.
