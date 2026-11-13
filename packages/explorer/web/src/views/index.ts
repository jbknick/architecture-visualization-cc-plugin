// Registers the filter panels and focus prompts for the views built in issue #37.
import { registerFilterPanel, registerFocusRequired } from "../slots.ts";
import { EgoPanel } from "./EgoPanel.tsx";
import { EgoPrompt } from "./EgoPrompt.tsx";
import { ProjectMapPanel } from "./ProjectMapPanel.tsx";

registerFilterPanel("project-map", ProjectMapPanel);
registerFilterPanel("ego", EgoPanel);
registerFocusRequired("ego", EgoPrompt);
