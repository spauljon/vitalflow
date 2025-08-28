import {Annotation} from "@langchain/langgraph";
import {FhirBundle} from "./fhirBundle.mjs";
import {Trends} from "./trend-math.mjs";
import {z} from "zod";

export const IntentSchema = z.enum([
  "trend",
  "metrics",
  "fetch",
  "summarize",
  "alert",
  "unknown",
]);

export type Intent = z.infer<typeof IntentSchema>;

export const State = Annotation.Root({
  query: Annotation<string>(),
  params: Annotation<{
    patientId?: string;
    codes?: string[];
    since?: string;
    until?: string;
    count?: number;
    maxItems?: number;
  }>({
    reducer: (prev, next) => ({...prev, ...next}),
    default: () => ({})
  }),

  route: Annotation<Intent>(),
  bundle: Annotation<FhirBundle>(),
  trends: Annotation<Trends>,
  summary: Annotation<string>(),
});

