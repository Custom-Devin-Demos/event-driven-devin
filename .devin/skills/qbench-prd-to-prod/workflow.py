"""QBench Workflow 1 — PRD (ClickUp task) -> plan -> 3 parallel implementations -> verify -> PR.

Run via the `run_workflow` tool with `script_path` pointing at this file. The orchestrating
session must first write the spec to the path in QBENCH_WF1_SPEC (default
/home/ubuntu/qbench_wf1_spec.json):

    {"task_id": "86bbz3u51", "task_url": "https://app.clickup.com/t/86bbz3u51",
     "title": "...", "description": "..."}

The workflow stops at the PR: humans review/approve, a human merges to main, and the repo's
existing deploy workflow (.github/workflows/deploy.yml) ships it. The orchestrating session
posts the plan/PR back to ClickUp using the structured outputs this script logs.
"""
import asyncio
import json
import os

REPO = "COG-GTM/event-driven-devin"
SPEC_PATH = os.environ.get("QBENCH_WF1_SPEC", "/home/ubuntu/qbench_wf1_spec.json")
IMPLEMENTOR_COUNT = 3

with open(SPEC_PATH, encoding="utf-8") as fh:
    SPEC = json.load(fh)

SPEC_JSON = json.dumps(SPEC, sort_keys=True, indent=2)

SCOPE_RULES = (
    "Scope rules: work only in the QBench LIMS vertical (app/services/verticals/qbench.js, "
    "app/routes/verticals/qbench.js, app/public/verticals/qbench.html, tests/qbench-coa.test.js, "
    "config/customers/qbench.js). Do not touch other verticals or their intentional bugs. Do not edit "
    "app/routes/verticals/index.js (verticals are auto-discovered). Do not remove or 'fix' the "
    "heavy_metals SPEC_LIMITS gap in resolveSpecLimits unless the spec explicitly asks for it — it is "
    "a separate seeded incident. Every commit message must contain the word 'feature' or 'bug'."
)

META = {
    "name": "qbench-prd-to-prod",
    "description": "ClickUp PRD -> plan -> 3 parallel implementations -> verifier picks winner -> PR for human review",
    "product": "QBench LIMS vertical (/qbench) in event-driven-devin",
    "soft_time_limit_minutes": 30,
    "phases": [
        {"title": "plan", "detail": "Turn the ClickUp task into acceptance criteria and a file-level plan", "count": 1},
        {"title": "implement", "detail": "Independent implementations on separate branches",
         "labels": [f"implement-{i + 1}" for i in range(IMPLEMENTOR_COUNT)]},
        {"title": "verify", "detail": "Run tests/lint on every branch and pick the winner", "count": 1},
        {"title": "pull-request", "detail": "Open the PR from the winning branch for human review", "count": 1},
    ],
}

PLAN_SCHEMA = {
    "type": "object",
    "properties": {
        "acceptance_criteria": {"type": "array", "items": {"type": "string"}},
        "files_to_touch": {"type": "array", "items": {"type": "string"}},
        "test_cases": {"type": "array", "items": {"type": "string"}},
        "summary": {"type": "string"},
    },
    "required": ["acceptance_criteria", "files_to_touch", "test_cases", "summary"],
}

IMPL_SCHEMA = {
    "type": "object",
    "properties": {
        "branch": {"type": "string"},
        "summary": {"type": "string"},
        "tests_passed": {"type": "boolean"},
        "lint_passed": {"type": "boolean"},
    },
    "required": ["branch", "summary", "tests_passed", "lint_passed"],
}

VERIFY_SCHEMA = {
    "type": "object",
    "properties": {
        "winner_branch": {"type": "string"},
        "rationale": {"type": "string"},
        "per_branch": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["winner_branch", "rationale", "per_branch"],
}

PR_SCHEMA = {
    "type": "object",
    "properties": {"pr_url": {"type": "string"}, "summary": {"type": "string"}},
    "required": ["pr_url", "summary"],
}


async def plan_stage():
    return await agent(
        f"Repository: {REPO}. You are the planning stage of a PRD-to-production workflow. "
        f"The ClickUp task below is the product spec:\n{SPEC_JSON}\n\n"
        "Read AGENTS.md and the QBench vertical files, then produce: concrete acceptance criteria "
        "(testable statements), the exact files to touch, and the unit test cases to add to "
        "tests/qbench-coa.test.js. Do NOT write code or push anything. "
        f"{SCOPE_RULES}",
        phase="plan",
        schema=PLAN_SCHEMA,
        repos=[REPO],
        mode="lite",
        soft_time_limit_minutes=10,
    )


async def implement_stage(plan, index):
    branch = f"devin/wf1-{SPEC['task_id']}-impl-{index + 1}"
    plan_json = json.dumps(plan, sort_keys=True, indent=2)
    return await agent(
        f"Repository: {REPO}. You are implementation candidate #{index + 1} of {IMPLEMENTOR_COUNT} in a "
        "PRD-to-production workflow; other candidates work independently and a verifier will choose one.\n\n"
        f"ClickUp task (spec):\n{SPEC_JSON}\n\nApproved plan:\n{plan_json}\n\n"
        f"Create branch `{branch}` from origin/main and implement the plan. Add/update tests in "
        "tests/qbench-coa.test.js. Run `npx jest tests/qbench-coa.test.js tests/verticals-registry.test.js` "
        "and `npm run lint`; both must pass. Push the branch (do NOT open a PR). Report the exact branch "
        f"name, a 3-line summary, and whether tests and lint passed. {SCOPE_RULES}",
        phase="implement",
        schema=IMPL_SCHEMA,
        label=f"implement-{index + 1}",
        repos=[REPO],
        soft_time_limit_minutes=30,
    )


async def verify_stage(plan, impls):
    candidates = json.dumps(impls, sort_keys=True, indent=2)
    plan_json = json.dumps(plan, sort_keys=True, indent=2)
    return await agent(
        f"Repository: {REPO}. You are the verifier in a PRD-to-production workflow.\n\n"
        f"ClickUp task (spec):\n{SPEC_JSON}\n\nPlan / acceptance criteria:\n{plan_json}\n\n"
        f"Candidate branches:\n{candidates}\n\n"
        "For each branch: fetch it, run `npx jest tests/qbench-coa.test.js tests/verticals-registry.test.js` "
        "and `npm run lint`, review the diff against origin/main for scope creep and acceptance-criteria "
        "coverage. Pick exactly one winner (smallest correct diff that satisfies every criterion with passing "
        "tests). Do not modify any branch and do not open a PR. Report the winner branch, rationale, and one "
        "line per branch.",
        phase="verify",
        schema=VERIFY_SCHEMA,
        repos=[REPO],
        soft_time_limit_minutes=20,
    )


async def pr_stage(plan, verdict):
    plan_json = json.dumps(plan, sort_keys=True, indent=2)
    return await agent(
        f"Repository: {REPO}. Open the pull request for a PRD-to-production workflow.\n\n"
        f"ClickUp task:\n{SPEC_JSON}\n\nPlan:\n{plan_json}\n\nVerifier verdict:\n"
        f"{json.dumps(verdict, sort_keys=True, indent=2)}\n\n"
        f"Check out branch `{verdict['winner_branch']}`, confirm tests and lint still pass, then open ONE PR "
        f"against main. Title: \"{SPEC.get('title', 'QBench feature')} (CU-{SPEC['task_id']})\". Body: summary, "
        "acceptance criteria and how each was verified, the verifier rationale (mention the other candidate "
        f"branches were discarded), a link to the ClickUp task {SPEC.get('task_url', '')}, and end with the "
        "line `Devin-Org: engineering` on its own line. Do NOT merge. Report the PR URL.",
        phase="pull-request",
        schema=PR_SCHEMA,
        repos=[REPO],
        mode="lite",
        soft_time_limit_minutes=10,
    )


async def main():
    await register_workflow(META)
    log(f"Spec loaded for ClickUp task {SPEC['task_id']}: {SPEC.get('title', '')}")

    plan = await agent_or_fail(plan_stage())
    log("PLAN_JSON=" + json.dumps(plan, sort_keys=True))

    async def run_impl(i):
        try:
            result = await implement_stage(plan, i)
            log(f"implement-{i + 1}: {result['branch']} tests={result['tests_passed']} lint={result['lint_passed']}")
            return result
        except WorkflowAgentError as exc:
            log(f"implement-{i + 1} failed: {exc}")
            return None

    def make_thunk(i):
        async def thunk():
            return await run_impl(i)
        return thunk

    results = await parallel([make_thunk(i) for i in range(IMPLEMENTOR_COUNT)])
    impls = [r for r in results if r]
    if not impls:
        raise RuntimeError("Every implementation candidate failed; nothing to verify")

    verdict = await agent_or_fail(verify_stage(plan, impls))
    log("VERDICT_JSON=" + json.dumps(verdict, sort_keys=True))

    pr = await agent_or_fail(pr_stage(plan, verdict))
    log("PR_JSON=" + json.dumps(pr, sort_keys=True))
    log(f"Done. PR ready for human review: {pr['pr_url']}. Merge to main triggers deploy.yml.")


async def agent_or_fail(coro):
    try:
        return await coro
    except WorkflowAgentError as exc:
        raise RuntimeError(f"Workflow stage failed: {exc}")


asyncio.run(main())
