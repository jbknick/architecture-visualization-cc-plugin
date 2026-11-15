// Registers the filter panels and focus prompts for the views built in issue #37.
import { registerFilterPanel, registerFocusRequired } from "../slots.ts";
import { DuplicatesPanel } from "./DuplicatesPanel.tsx";
import { EgoPanel } from "./EgoPanel.tsx";
import { EgoPrompt } from "./EgoPrompt.tsx";
import { PagesPanel } from "./PagesPanel.tsx";
import { ProjectMapPanel } from "./ProjectMapPanel.tsx";
import { ReviewPanel } from "./ReviewPanel.tsx";
import { SlicesPanel } from "./SlicesPanel.tsx";

registerFilterPanel("project-map", ProjectMapPanel);
registerFilterPanel("ego", EgoPanel);
registerFilterPanel("duplicates", DuplicatesPanel);
registerFocusRequired("ego", EgoPrompt);
registerFilterPanel("pages", PagesPanel);
registerFilterPanel("slices", SlicesPanel);
registerFilterPanel("review", ReviewPanel);
