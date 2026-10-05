import { render } from "preact";

import "../ui/theme.css";

import { DownloadsPage, startDownloadsPage } from "./downloads/DownloadsPage.js";

render(<DownloadsPage />, document.getElementById("app")!);

// Read both sources and subscribe to the background's broadcasts before the first
// paint settles, so a job that finishes while the tab is still loading is not missed.
startDownloadsPage();
