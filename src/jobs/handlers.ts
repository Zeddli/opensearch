// Job handlers — owned by AGENTS. Registered at module top level. This module is loaded on
// server start (instrumentation.ts) and lazily before any job runs.
// Every handler catches its own errors so a failing agent never crashes the runner.
import { registerJob } from "./runner";
import { considerRequest, respondToCounter, type ConsiderPayload, type CounterPayload } from "@/src/agents/seller/agent";
import { analyzeRequest, answerSellerQuestion, type AnalyzePayload, type AnswerPayload } from "@/src/agents/buyer/analyze";
import { logEvent } from "@/src/agents/util";

function safe<T>(name: string, fn: (p: T) => Promise<void>) {
  return async (p: T) => {
    try {
      await fn(p);
    } catch (err) {
      console.error(`[jobs] ${name} failed`, err);
      const requestId = (p as { requestId?: string } | null)?.requestId ?? null;
      await logEvent({ requestId, actor: "system", tool: name, input: p, output: { error: String(err) }, decision: "error" });
    }
  };
}

registerJob<ConsiderPayload>("seller.consider", safe("seller.consider", considerRequest));
registerJob<CounterPayload>("seller.respond_counter", safe("seller.respond_counter", respondToCounter));
registerJob<AnalyzePayload>("buyer.analyze", safe("buyer.analyze", analyzeRequest));
registerJob<AnswerPayload>("buyer.answer_question", safe("buyer.answer_question", answerSellerQuestion));
