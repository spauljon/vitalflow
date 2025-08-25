import {Annotation} from "@langchain/langgraph";
import {FhirBundle} from "./fhirBundle.mjs";

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

  route: Annotation<"fetch" | "summarize" | "unknown">(),
  bundle: Annotation<FhirBundle>(),
  summary: Annotation<string>(),
});

