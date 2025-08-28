import {END, MemorySaver, START, StateGraph} from "@langchain/langgraph";
import {intakeNode} from "./intakeNode.mjs";
import {State} from "./state.mjs";
import {dataAgent, FHIR_MCP_URL} from "./dataAgent.mjs";
import {makeSummarizerNode} from "./summarizer.mjs";
import {makePlannerNode} from "./plannerAgent.mjs";
import {getMcpClient} from "./mcpSession.mjs";
import {makeTrendNode} from "./trend.mjs";
import {writeFileSync} from "node:fs";

const planner =
  makePlannerNode<typeof State.State>({model: process.env.PLANNER_MODEL});

const trendWithFetch = makeTrendNode({
  fhirClient: getMcpClient("trend-thread", FHIR_MCP_URL),
  preferExistingItems: true,
  defaultWindowDays: 30,
  frequency: "auto",
  maxItems: 500
});

const graph = new StateGraph(State)
  .addNode("intake", intakeNode)
  .addNode("planner", planner)
  .addNode("data_agent", dataAgent)
  .addNode("trend", trendWithFetch)
  .addNode("summarizer", makeSummarizerNode(/* call the factory! */))

  .addEdge(START, "intake")
  .addEdge("intake", "planner")

  .addConditionalEdges("planner", (s) => {
    if (["fetch", "metrics"].includes(s.route)) {
      return "data_agent";
    }

    return s.route;
  })

  .addEdge("data_agent", "summarizer")
  .addEdge("trend", END)
  .addEdge("summarizer", END);

export const stateGraph = graph.compile({checkpointer: new MemorySaver()});

