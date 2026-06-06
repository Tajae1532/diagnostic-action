const core = require("@actions/core");
const github = require("@actions/github");
const https = require("https");
const http = require("http");
const { URL } = require("url");

const MAX_LOG_CHARS = 50_000;

async function run() {
  try {
    const apiKey = core.getInput("api_key", { required: true });
    const apiUrl = core.getInput("api_url") || "https://api.diagnosticagent.dev";
    const maxLogLines = parseInt(core.getInput("max_log_lines") || "200", 10);
    const failOnPlatformIssue = core.getInput("fail_on_platform_issue") === "true";
    const debug = core.getInput("debug") === "true";

    const ctx = github.context;
    const repo = `${ctx.repo.owner}/${ctx.repo.repo}`;
    const branch = ctx.ref?.replace("refs/heads/", "") || "";
    const workflowName = ctx.workflow || "";
    const jobName = ctx.job || "";
    const runId = String(ctx.runId || "");

    const failedStep =
      process.env.GITHUB_ACTION ||
      process.env.GITHUB_JOB ||
      jobName ||
      "unknown step";

    const logLines = collectLogContext(maxLogLines);

    if (debug) {
      core.info(`[diagnostic] collected ${logLines.length} log lines`);
      core.info(`[diagnostic] repo=${repo} branch=${branch} step=${failedStep}`);
    }

    core.info("Running pipeline failure diagnostic...");

    const payload = {
      failed_step: failedStep,
      logs: logLines.join("\n"),
      repo,
      branch,
      ci_system: "github_actions",
      workflow_name: workflowName,
      job_name: jobName,
      run_id: runId,
    };

    let result;
    try {
      result = await postJson(`${apiUrl}/api/v1/diagnose`, payload, apiKey);
    } catch (err) {
      core.warning(`[diagnostic] API call failed: ${err.message}`);
      core.warning("[diagnostic] Skipping diagnosis — your build failure stands on its own.");
      return;
    }

    if (debug) {
      core.info(`[diagnostic] response: ${JSON.stringify(result, null, 2)}`);
    }

    const classification = result?.classification;
    if (!classification) {
      core.warning("[diagnostic] Unexpected API response shape — skipping output.");
      return;
    }

    const {
      category,
      confidence,
      owner,
      summary,
      recommended_action,
      signals,
      classifier_version,
      matched_example_id,
      similarity,
    } = classification;

    const deflectTicket = shouldDeflectTicket(category, confidence);

    printDiagnosis({
      category,
      confidence,
      owner,
      summary,
      recommended_action,
      signals,
      classifier_version,
      matched_example_id,
      similarity,
      deflectTicket,
      failedStep,
      repo,
      branch,
    });

    core.setOutput("category", category || "");
    core.setOutput("confidence", String(confidence || 0));
    core.setOutput("owner", owner || "");
    core.setOutput("summary", summary || "");
    core.setOutput("recommended_action", recommended_action || "");
    core.setOutput("deflect_ticket", String(deflectTicket));

    if (failOnPlatformIssue && category === "platform_issue") {
      core.setFailed("[diagnostic] Platform issue detected.");
    }
  } catch (err) {
    core.warning(`[diagnostic] Unexpected error: ${err.message}`);
  }
}

function collectLogContext(maxLines) {
  const lines = [];

  lines.push(
    `GITHUB_WORKFLOW: ${process.env.GITHUB_WORKFLOW || ""}`,
    `GITHUB_JOB: ${process.env.GITHUB_JOB || ""}`,
    `GITHUB_ACTION: ${process.env.GITHUB_ACTION || ""}`,
    `GITHUB_REF: ${process.env.GITHUB_REF || ""}`,
    `GITHUB_SHA: ${process.env.GITHUB_SHA || ""}`,
    `GITHUB_RUN_ID: ${process.env.GITHUB_RUN_ID || ""}`,
    `GITHUB_RUN_ATTEMPT: ${process.env.GITHUB_RUN_ATTEMPT || ""}`,
    `RUNNER_OS: ${process.env.RUNNER_OS || ""}`,
    `RUNNER_ARCH: ${process.env.RUNNER_ARCH || ""}`
  );

  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (summaryFile) {
    try {
      const fs = require("fs");
      if (fs.existsSync(summaryFile)) {
        const content = fs.readFileSync(summaryFile, "utf8");
        lines.push("--- STEP SUMMARY ---");
        lines.push(...content.split("\n").slice(0, 50));
      }
    } catch (_) {}
  }

  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    try {
      const fs = require("fs");
      if (fs.existsSync(outputFile)) {
        const content = fs.readFileSync(outputFile, "utf8");
        lines.push("--- PREVIOUS STEP OUTPUTS ---");
        lines.push(...content.split("\n").slice(0, 20));
      }
    } catch (_) {}
  }
  const buildLogFile = process.env.BUILD_LOG_FILE;
    if (buildLogFile) {
        try {
            const fs = require("fs");
            if (fs.existsSync(buildLogFile)) {
                const content = fs.readFileSync(buildLogFile, "utf8");
                lines.push("--- BUILD LOG ---");
                lines.push(...content.split("\n").slice(-300));
            }
        } catch (_) {}
    }
  return lines.slice(0, maxLines);
}

function shouldDeflectTicket(category, confidence) {
  if (!category || confidence == null) return false;
  if (category === "platform_issue") return false;
  return confidence >= 0.65;
}

function formatCategory(category) {
  return (
    {
      user_error: "User / configuration error",
      external_dependency: "External dependency issue",
      platform_issue: "Platform / infrastructure issue",
    }[category] || category
  );
}

function printDiagnosis({
  category,
  confidence,
  owner,
  summary,
  recommended_action,
  signals,
  classifier_version,
  matched_example_id,
  similarity,
  deflectTicket,
  failedStep,
  repo,
  branch,
}) {
  const confidencePct =
    confidence != null ? `${Math.round(confidence * 100)}%` : "N/A";

  core.startGroup("Pipeline Failure Diagnostic");
  core.info("");
  core.info(`  Failed step : ${failedStep}`);
  core.info(`  Repo        : ${repo}  (${branch})`);
  core.info("");
  core.info("-----------------------------------------------------");
  core.info(`  Category    : ${formatCategory(category)}`);
  core.info(`  Confidence  : ${confidencePct}`);
  core.info(`  Owner       : ${owner}`);
  core.info("");
  core.info("  Diagnosis");
  core.info(`  ${summary}`);

  if (recommended_action) {
    core.info("");
    core.info("  Recommended action");
    core.info(`  ${recommended_action}`);
  }

  if (deflectTicket) {
    core.info("");
    core.info("  No support ticket needed — this is not a platform issue.");
  } else if (category === "platform_issue") {
    core.info("");
    core.info("  This looks like a platform issue. File a ticket with the platform team.");
  }

  if (matched_example_id) {
    core.info("");
    core.info(`  Matched example : ${matched_example_id}  (similarity ${similarity})`);
  }

  if (signals && signals.length > 0) {
    core.info("");
    core.info("  Signals detected");
    signals.slice(0, 5).forEach((s) => core.info(`    - ${s}`));
  }

  core.info("");
  core.info(`  Classifier  : ${classifier_version || "deterministic-v1"}`);
  core.info("-----------------------------------------------------");
  core.info("");
  core.endGroup();
}

function postJson(urlString, body, apiKey) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlString);
    const isHttps = parsed.protocol === "https:";
    const transport = isHttps ? https : http;

    const bodyString = JSON.stringify(body);
    const truncated =
      bodyString.length > MAX_LOG_CHARS * 2
        ? JSON.stringify({ ...body, logs: body.logs.slice(-MAX_LOG_CHARS) })
        : bodyString;

    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + (parsed.search || ""),
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(truncated),
        "X-API-Key": apiKey,
        "User-Agent": "diagnostic-action/1.0.0",
      },
      timeout: 15_000,
    };

    const req = transport.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error(`Failed to parse API response: ${e.message}`));
          }
        } else {
          reject(
            new Error(`API returned ${res.statusCode}: ${data.slice(0, 200)}`)
          );
        }
      });
    });

    req.on("error", (err) => reject(err));
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("API request timed out after 15 seconds"));
    });

    req.write(truncated);
    req.end();
  });
}

run();