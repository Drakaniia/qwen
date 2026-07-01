
Plan A — Service Worker Capture (Layer 3): SW registration → media response interception → message relay → background assembly. Estimated ~1 week.
Plan B — fMP4 Demuxer (Python) (Layer 4): ISO BMFF box parser → track demuxing → MP4 reassembly → ffmpeg integration. Estimated ~1.5 weeks.
Plan C — CDP Browser Tunnel + Cookie Injection (Layer 6 + CF enhancement): CDP fetch tunnel → cookie extraction → header injection → tunnel progress. Estimated ~1.5 weeks.
Plan D — Enhanced CDP Extraction (Layer 2 enhancement): Shadow DOM, iframe recursion, mutation watching. Estimated ~3-4 days.
Plan E — EME Multi-key + Key Rotation (Layer 5 enhancement): Multi-key sessions, session caching, key rotation detection. Estimated ~1 week.
Plan F — Layered Fallback Orchestration (Layer integration): Formal layer fallback chain in  download_orchestration.js . Estimated ~1 week.