"""Generates docs/chorus/evals/routing.jsonl, the 200-utterance routing eval (PLAN.md §9.3).

Deterministic: rerun after editing templates. Each row is a speech-recognizer-style transcript with
the expected route. `expect.kind` is a grammar command kind, or "model" when the utterance should
fall through the fast-path grammar to Jev/Claude (instructions that need rewriting, broad goals,
questions about the project).

    python docs/chorus/evals/generate-routing.py
"""

import json
import random
from pathlib import Path

rng = random.Random(7)

ROSTER = [
    {"id": "c1", "name": "Claude 1", "providerLabel": "Claude", "taskName": "auth-refactor"},
    {"id": "c2", "name": "Claude 2", "providerLabel": "Claude", "taskName": "settings-page"},
    {"id": "x1", "name": "Codex 1", "providerLabel": "Codex", "taskName": "api-tests"},
    {"id": "g1", "name": "Gemini 1", "providerLabel": "Gemini", "taskName": "docs"},
]

# How recognizers render each agent name (misheard variants included).
SPOKEN = {
    "Claude 1": ["Claude 1", "claude one", "Clod one", "cloud 1", "Claude won"],
    "Claude 2": ["Claude 2", "claude two", "Clod 2", "claud two", "Claude too"],
    "Codex 1": ["Codex 1", "codex one", "codecs one", "Codex", "the codex one", "kodex"],
    "Gemini 1": ["Gemini 1", "gemini one", "Gemini", "the gemini one"],
}
FILLERS = ["", "", "", "uh ", "um, ", "okay ", "so ", "hey chorus, ", "alright "]
POLITE = ["", "", "", " please", ", thanks"]
ENDINGS = ["", ".", ".", "?"]

rows = []


def add(utterance, expect, focused=None, tag=""):
    rows.append({"utterance": utterance, "focused": focused, "expect": expect, "tag": tag})


def noisy(text):
    return (rng.choice(FILLERS) + text + rng.choice(POLITE)).strip() + rng.choice(ENDINGS)


def agent_id(name):
    return next(a["id"] for a in ROSTER if a["name"] == name)


# Confirm / reject / fixed commands.
for text in ["yes", "yeah", "yep", "go ahead", "approve", "do it", "confirm", "allow it"]:
    add(noisy(text), {"kind": "confirm"}, tag="confirm")
for text in ["no", "nope", "cancel", "never mind", "deny", "reject", "abort"]:
    add(noisy(text), {"kind": "reject"}, tag="reject")
for text in ["next", "next one", "who needs me", "what's next", "next agent", "who's waiting"]:
    add(noisy(text), {"kind": "next"}, tag="next")
for text in ["show all", "zoom out", "overview", "show me everything", "show all agents", "fit all"]:
    add(noisy(text), {"kind": "overview"}, tag="overview")
for text in ["send it", "submit", "hit enter", "press enter", "submit it"]:
    add(noisy(text), {"kind": "submit"}, tag="submit")
for text in ["mute", "be quiet", "stop talking"]:
    add(noisy(text), {"kind": "mute"}, tag="mute")
for text in ["unmute", "talk to me"]:
    add(noisy(text), {"kind": "unmute"}, tag="unmute")
for note in ["ship the voice HUD", "check the flaky test tomorrow", "ask Sam about the API keys"]:
    for lead in ["take a note:", "add a note,", "note"]:
        add(f"{lead} {note}", {"kind": "note", "text": note}, tag="note")

# Focus / status / interrupt with every spoken variant.
FOCUS_VERBS = ["focus on", "go to", "show me", "switch to", "open", "jump to", "zoom in on"]
STATUS_FORMS = ["what's {a} doing", "what is {a} doing", "how's {a} doing", "is {a} done", "status of {a}"]
STOP_VERBS = ["stop", "interrupt", "pause", "halt"]
for name, variants in SPOKEN.items():
    for variant in variants:
        add(noisy(f"{rng.choice(FOCUS_VERBS)} {variant}"), {"kind": "focus", "agent": agent_id(name)}, tag="focus")
    for variant in variants:
        form = rng.choice(STATUS_FORMS)
        add(noisy(form.format(a=variant)), {"kind": "status", "agent": agent_id(name)}, tag="status")
    for variant in variants:
        add(noisy(f"{rng.choice(STOP_VERBS)} {variant}"), {"kind": "interrupt", "agent": agent_id(name)}, tag="interrupt")
    for variant in variants:
        add(noisy(f"{rng.choice(FOCUS_VERBS)} {variant}"), {"kind": "focus", "agent": agent_id(name)}, tag="focus")

# Deictics resolve to the focused agent.
for text, kind in [("focus on this one", "focus"), ("what's it doing", "status"), ("stop it", "interrupt"), ("is this one done", "status")]:
    add(noisy(text), {"kind": kind, "agent": "x1"}, focused="x1", tag="deictic")

# Sends: "tell X to …", "ask X …", vocative "X, …". Instruction text must survive intact.
INSTRUCTIONS = [
    "run the tests",
    "fix the lint errors",
    "add a loading spinner to the settings page",
    "commit and push your branch",
    "explain why the build failed",
    "use the new logger instead of console.log",
    "rebase on main",
    "write docs for the auth module",
]
for name, variants in SPOKEN.items():
    for variant in variants:
        for verb in ["tell", "ask"]:
            text = rng.choice(INSTRUCTIONS)
            add(noisy(f"{verb} {variant} to {text}"), {"kind": "send", "agent": agent_id(name), "text": text}, tag="send")
    text = rng.choice(INSTRUCTIONS)
    add(f"{SPOKEN[name][0]}, {text}.", {"kind": "send", "agent": agent_id(name), "text": text}, tag="vocative")
# The "to"/"two" homophone and numbered names next to "to".
add("tell Claude to to run the tests", {"kind": "send", "agent": "c2", "text": "run the tests"}, tag="homophone")
add("tell claude two to fix lint", {"kind": "send", "agent": "c2", "text": "fix lint"}, tag="homophone")
add("tell Claude 1 to deploy", {"kind": "send", "agent": "c1", "text": "deploy"}, tag="homophone")
add("ask codex to add retries", {"kind": "send", "agent": "x1", "text": "add retries"}, tag="homophone")

# Ambiguity: "Claude" alone matches two agents -> a clarifying question, never a guess.
for text in ["focus on Claude", "what's claude doing", "stop claude", "tell claude to run the tests"]:
    add(noisy(text), {"kind": "clarify"}, tag="ambiguous")

# Unknown agents fall through (the model can explain or ask).
for text in ["focus on Cursor 3", "what's Copilot doing", "stop Aider"]:
    add(noisy(text), {"kind": "model"}, tag="unknown-agent")

# Broad goals, planning, project questions, multi-step asks: never the grammar's job.
MODEL = [
    "build a settings page with dark mode and split it between Claude and Codex",
    "can you split the auth rewrite across three agents",
    "spin up an agent to migrate us to the new router",
    "which agents are going to conflict",
    "what changed in the api tests branch",
    "summarize what everyone is working on",
    "have Claude 1 review what Codex did and then fix anything it finds",
    "start a new agent on the docs",
    "why is the build red",
    "archive the gemini task, it's done",
    "rename Claude 2 to Settings",
    "plan the payments feature",
    "make the canvas less cluttered",
    "compare the two claude branches",
    "is anything waiting on me for permission and if so what does it want",
    "refactor the logging across the whole repo in parallel",
    "check for merge conflicts between claude one and codex",
    "give codex the same instructions as claude two",
    "what did I ask claude one earlier",
    "set up a plan to add oauth with google and github",
]
for text in MODEL:
    add(noisy(text), {"kind": "model"}, tag="model")

assert len(rows) >= 200, len(rows)
rng.shuffle(rows)
rows = rows[:200]
out = Path(__file__).with_name("routing.jsonl")
with out.open("w", encoding="utf-8", newline="\n") as handle:
    handle.write(json.dumps({"roster": ROSTER}) + "\n")
    for row in rows:
        handle.write(json.dumps(row) + "\n")
print(f"wrote {len(rows)} cases to {out}")
