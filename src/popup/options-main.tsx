import { render } from "preact";

import "../ui/theme.css";

import { OptionsPage, startOptionsPage } from "./options/OptionsPage.js";

render(<OptionsPage />, document.getElementById("app")!);

startOptionsPage();
