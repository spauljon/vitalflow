import {Annotation} from "@langchain/langgraph";
import {FhirBundle} from "./fhirBundle.mjs";
import {Trends} from "./trend.mjs";

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

  route: Annotation<"metrics" | "fetch" | "summarize" | "unknown">(),
  bundle: Annotation<FhirBundle>(),
  trends: Annotation<Trends>,
  summary: Annotation<string>(),
});

