// Registers the filter panels and focus prompts for the views built in issue #37.
import { registerFilterPanel, registerFocusRequired } from "../slots.ts";
import {
  ApiTablesPanel,
  EndpointsPanel,
  FeaturePathPanel,
  PageApiPanel,
  TableUsagePanel,
} from "./CrossStackPanel.tsx";
import { DuplicatesPanel } from "./DuplicatesPanel.tsx";
import { EgoPanel } from "./EgoPanel.tsx";
import { EgoPrompt } from "./EgoPrompt.tsx";
import { FlowFocusPrompt } from "./FlowFocusPrompt.tsx";
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
// The cross-stack views (#48); the feature path and table usage need a focus.
registerFilterPanel("endpoints", EndpointsPanel);
registerFilterPanel("page-api", PageApiPanel);
registerFilterPanel("api-tables", ApiTablesPanel);
registerFilterPanel("feature-path", FeaturePathPanel);
registerFilterPanel("table-usage", TableUsagePanel);
registerFocusRequired("feature-path", FlowFocusPrompt);
registerFocusRequired("table-usage", FlowFocusPrompt);
