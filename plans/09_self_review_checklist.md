# Self-Review Checklist

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Verify implementation plans match the Milkdown-first MVP spec before execution.

**Architecture:** Review the package as a whole. Fix issues in the plan documents before writing product code.

**Tech Stack:** Markdown review, grep, TypeScript type consistency.

---

### Task 1: Spec coverage review

**Files:**
- Review: `00_scope_and_decisions.md`
- Review: `01_product_requirements.md`
- Review: `plans/*.md`

- [ ] **Step 1: Verify Milkdown-first decision is represented**

Run:

```bash
grep -R "Milkdown" -n 00_scope_and_decisions.md 02_architecture_milkdown_first.md plans
```

Expected: references appear in scope, architecture, and Milkdown spike plan.

- [ ] **Step 2: Verify local sync is excluded**

Run:

```bash
grep -R "Local sync" -n 00_scope_and_decisions.md 07_risks_and_attention.md README.md
```

Expected: each file states local sync is not in MVP.

- [ ] **Step 3: Verify no insert API is required**

Run:

```bash
grep -R "insert_doc" -n .
```

Expected: only appears as out-of-scope or not-required text, not as an implementation task.

### Task 2: Placeholder scan

**Files:**
- Review: all Markdown files.

- [ ] **Step 1: Search for placeholder language**

Read each plan section that contains implementation steps and verify that every code-changing step includes concrete file paths, command lines, and code blocks.

Expected: no vague implementation instructions remain.

### Task 3: Type consistency review

**Files:**
- Review: `04_data_model_and_api.md`
- Review: `plans/*.md`

- [ ] **Step 1: Check request field naming**

Run:

```bash
grep -R "baseVersionId\|base_version" -n 04_data_model_and_api.md plans
```

Expected: API JSON in implementation plans uses camelCase (`baseVersionId`, `baseHash`, `oldString`, `newString`). SQL docs may use snake_case for table fields.

- [ ] **Step 2: Check branch room naming**

Run:

```bash
grep -R "doc:.*branch" -n 02_architecture_milkdown_first.md plans
```

Expected: room names follow `doc:{docId}:branch:{branchId}`.

### Task 4: Execution readiness

**Files:**
- Review: `plans/01_foundation_repo_plan.md`
- Review: `plans/02_milkdown_roundtrip_collab_spike_plan.md`

- [ ] **Step 1: Confirm first two plans produce testable output**

Expected:

```text
Plan 01 produces passing unit tests for hash/edit/export filename utilities.
Plan 02 produces Markdown canonicalization tests and a Milkdown editor wrapper that can be typechecked.
```

- [ ] **Step 2: Confirm frequent commits are included**

Run:

```bash
grep -R "git commit -m" -n plans | wc -l
```

Expected: output is at least `20`.

### Task 5: Corrected risk checks

**Files:**
- Review: `plans/*.md`
- Review: `02_architecture_milkdown_first.md`
- Review: `04_data_model_and_api.md`

- [ ] **Step 1: Verify no mirror-only AI write path remains**

Run:

```bash
grep -R "first pass updates the mirror\\|mirror-only\\|directly updates current_markdown" -n plans 02_architecture_milkdown_first.md 04_data_model_and_api.md
```

Expected: Any matches are context notes explaining the rejected original approach, not executable implementation steps.

- [ ] **Step 2: Verify transaction examples use checked-out clients**

Run:

```bash
grep -R "pool\\.query('begin'\\|pool\\.query('commit'\\|pool\\.query('rollback'" -n plans
```

Expected: no matches.

- [ ] **Step 3: Verify empty Yjs byte buffers are not used**

Run:

```bash
grep -R "Buffer.from(\\[\\])" -n plans
```

Expected: no matches.

- [ ] **Step 4: Verify agent snapshot workflow uses proposal-only snapshots**

Run:

```bash
grep -R "before\\.md\\|after\\.md\\|baseline\\.md\\|submit-snapshot" -n 00_scope_and_decisions.md 01_product_requirements.md 04_data_model_and_api.md 05_ai_write_versioning_branching.md plans
```

Expected: matches only appear in statements forbidding those files or commands. The executable workflow should use `proposal.md` plus `metadata.json`.

- [ ] **Step 5: Verify Plan 7 is CLI + skill first**

Run:

```bash
test -f plans/07_cli_agent_skill_plan.md && ! test -f plans/07_mcp_agent_plan.md
```

Expected: command exits with status 0. MCP may appear only as a later adapter, not as the MVP-critical Plan 7.
