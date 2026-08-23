const DATA_FILES = {
  project: "../.overview/project.json",
  modules: "../.overview/modules.json",
  architecture: "../.overview/architecture.json",
  tasks: "../.overview/tasks.json",
  risks: "../.overview/risks.json",
  decisions: "../.overview/decisions.json",
  changelog: "../.overview/changelog.json",
  snapshot: "../.overview/snapshot.json"
};

const STATUS_META = {
  planned: { label: "计划", symbol: "○", className: "planned" },
  doing: { label: "进行中", symbol: "●", className: "doing" },
  active: { label: "Active", symbol: "◐", className: "active" },
  implemented: { label: "已实现 / 待验收", symbol: "◐", className: "implemented" },
  verified: { label: "已验证", symbol: "✓", className: "verified" },
  accepted: { label: "验收通过", symbol: "✓", className: "accepted" },
  blocked: { label: "阻塞", symbol: "⚠", className: "blocked" },
  paused: { label: "暂缓", symbol: "Ⅱ", className: "paused" },
  stable: { label: "Stable", symbol: "●", className: "stable" },
  risk: { label: "Risk", symbol: "▲", className: "risk" },
  experimental: { label: "Experimental", symbol: "✦", className: "experimental" },
  dormant: { label: "Dormant", symbol: "○", className: "dormant" }
};

const debugBus = window.__PROJECT_OVERVIEW_DEBUG__ || {
  listeners: new Map(),
  publish(event, payload) {
    const callbacks = this.listeners.get(event) || [];
    callbacks.forEach((callback) => callback(payload));
    window.dispatchEvent(new CustomEvent(event, { detail: payload }));
  },
  subscribe(event, callback) {
    const callbacks = this.listeners.get(event) || [];
    callbacks.push(callback);
    this.listeners.set(event, callbacks);
    return () => this.listeners.set(event, callbacks.filter((item) => item !== callback));
  }
};

window.__PROJECT_OVERVIEW_DEBUG__ = debugBus;

const $ = (selector) => document.querySelector(selector);

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function getStatusMeta(status) {
  return STATUS_META[status] || { label: status, symbol: "·", className: "unknown" };
}

function formatDate(value) {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function formatAge(value) {
  const deltaHours = Math.round((new Date(value).getTime() - Date.now()) / 3600000);
  const absoluteHours = Math.abs(deltaHours);
  if (absoluteHours < 24) return `${absoluteHours || 1} 小时${deltaHours > 0 ? "后" : "前"}`;
  const days = Math.round(absoluteHours / 24);
  return `${days} 天${deltaHours > 0 ? "后" : "前"}`;
}

function formatNumber(value) {
  return new Intl.NumberFormat("zh-CN").format(value);
}

async function loadJson(path) {
  const response = await fetch(path, { cache: "no-store" });
  if (!response.ok) throw new Error(`${path} 返回 ${response.status}`);
  return response.json();
}

async function loadOverview() {
  debugBus.publish("overview:load-start", { files: Object.keys(DATA_FILES) });
  const entries = await Promise.all(
    Object.entries(DATA_FILES).map(async ([key, path]) => [key, await loadJson(path)])
  );
  const data = Object.fromEntries(entries);
  debugBus.publish("overview:load-complete", { observedCommit: data.snapshot.observedCommit });
  return data;
}

function renderStatus(status, includeLabel = true) {
  const meta = getStatusMeta(status);
  return `<span class="status-pill status-pill--${meta.className}"><span aria-hidden="true">${meta.symbol}</span>${includeLabel ? escapeHtml(meta.label) : ""}</span>`;
}

function renderProject(data) {
  const { project } = data.project;
  const { metrics, completion, now } = data.project;
  const snapshot = data.snapshot;
  const roadmapProgress = Math.round(
    data.project.roadmap.reduce((sum, item) => sum + item.implementationProgress, 0) / data.project.roadmap.length
  );

  $("#project-name").textContent = `${project.name} / ${project.codename}`;
  $("#project-status").textContent = project.status === "in_progress" ? "IN PROGRESS" : project.status.toUpperCase();
  $("#last-updated").textContent = `观测于 ${formatDate(snapshot.generatedAt)}`;
  $("#project-stage").textContent = project.stage;
  $("#project-description").textContent = project.description;
  $("#completion-progress").textContent = `${roadmapProgress}%`;
  $("#completion-ring").style.setProperty("--progress", `${roadmapProgress * 3.6}deg`);
  $("#completion-label").textContent = completion.label;
  $("#completion-confidence").textContent = `置信度 ${completion.confidence} · ${completion.reasons.length} 个未闭合证据`;
  $("#current-goal").textContent = now.goal;
  $("#last-commit").textContent = `${project.lastCommit.short} · ${project.lastCommit.message}`;

  $("#metric-grid").innerHTML = [
    ["版本", project.version, "release candidate"],
    ["代码规模", `${formatNumber(metrics.loc)} LOC`, `${formatNumber(metrics.files)} files`],
    ["模块", metrics.moduleCount, "tracked modules"],
    ["测试", `${metrics.tests.coverage}%`, `${metrics.tests.passed} passed · ${metrics.tests.failed} failed`],
    ["构建", metrics.build.status === "passed" ? "PASS" : "FAIL", formatAge(metrics.build.lastRunAt)],
    ["技术债", metrics.technicalDebtCount, `${metrics.riskCount} active risks`]
  ].map(([label, value, note]) => `
    <article class="metric-card">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
      <small>${escapeHtml(note)}</small>
    </article>
  `).join("");
}

function renderStaleness(snapshot) {
  const banner = $("#stale-banner");
  const isStale = snapshot.workingTree === "dirty" || ["stale", "partial", "unknown", "inconsistent"].includes(snapshot.freshness?.status);
  if (isStale) {
    banner.classList.remove("is-hidden");
    const reason = snapshot.workingTree === "dirty"
      ? `当前工作区存在 ${escapeHtml(snapshot.observedCommit)} 之后的改动`
      : escapeHtml(snapshot.freshness?.reason || "关键数据源没有完整覆盖");
    banner.innerHTML = `<strong>地图需要重新测绘</strong><span>${reason}，以下结论仅代表最近一次观测。</span>`;
    return;
  }
  banner.classList.add("is-hidden");
}

function renderRoadmap(roadmap) {
  $("#roadmap-list").innerHTML = roadmap.map((milestone) => `
    <article class="roadmap-card roadmap-card--${escapeHtml(milestone.status)}">
      <div class="roadmap-card__head">
        <div class="milestone-id">${escapeHtml(milestone.id)}</div>
        <div>
          <h3>${escapeHtml(milestone.title)}</h3>
          ${renderStatus(milestone.status)}
        </div>
      </div>
      <div class="progress-pair">
        <div class="progress-line">
          <span>实现</span>
          <div class="progress-track"><i style="width: ${milestone.implementationProgress}%"></i></div>
          <b>${milestone.implementationProgress}%</b>
        </div>
        <div class="progress-line progress-line--acceptance">
          <span>验收</span>
          <div class="progress-track"><i style="width: ${milestone.acceptanceProgress}%"></i></div>
          <b>${milestone.acceptanceProgress}%</b>
        </div>
      </div>
      <ul class="deliverable-list">
        ${milestone.deliverables.map((item) => `<li class="deliverable deliverable--${getStatusMeta(item.state).className}"><span aria-hidden="true">${getStatusMeta(item.state).symbol}</span>${escapeHtml(item.title)}</li>`).join("")}
      </ul>
    </article>
  `).join("");
}

function renderNow(now) {
  const columns = [
    ["Doing", "doing", now.doing],
    ["Next", "planned", now.next],
    ["Blocked", "blocked", now.blocked],
    ["Paused", "paused", now.paused]
  ];
  $("#now-board").innerHTML = columns.map(([label, status, items]) => `
    <article class="now-column now-column--${status}">
      <div class="now-column__heading"><span>${getStatusMeta(status).symbol}</span><h3>${label}</h3><b>${items.length}</b></div>
      <ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
    </article>
  `).join("");
}

function renderTasks(tasks) {
  const ordered = ["doing", "implemented", "blocked", "next", "accepted", "paused"];
  const visibleTasks = [...tasks].sort((left, right) => ordered.indexOf(left.bucket) - ordered.indexOf(right.bucket));
  const counts = tasks.reduce((result, task) => {
    result[task.bucket] = (result[task.bucket] || 0) + 1;
    return result;
  }, {});
  $("#task-summary").textContent = `${tasks.length} tracked · ${counts.accepted || 0} accepted`;
  $("#task-list").innerHTML = visibleTasks.map((task) => `
    <article class="task-row">
      <div class="task-row__main">
        <div class="task-row__title"><span class="task-id">${escapeHtml(task.id)}</span><strong>${escapeHtml(task.title)}</strong></div>
        <span class="task-meta">${escapeHtml(task.milestone)} · ${escapeHtml(task.owner)} · ${escapeHtml(task.priority)}</span>
      </div>
      <div class="task-row__evidence">
        ${renderStatus(task.status)}
        <span class="evidence-count">${task.acceptance.passed}/${task.acceptance.required} evidence</span>
      </div>
    </article>
  `).join("");
}

function renderRisks(risks) {
  const severityOrder = { high: 0, medium: 1, low: 2 };
  const sorted = [...risks].sort((left, right) => severityOrder[left.severity] - severityOrder[right.severity]);
  $("#risk-summary").textContent = `${risks.filter((risk) => risk.severity === "high").length} high · ${risks.length} total`;
  $("#risk-list").innerHTML = sorted.map((risk) => `
    <article class="risk-row risk-row--${escapeHtml(risk.severity)}">
      <div class="risk-severity"><span>${risk.severity.toUpperCase()}</span><small>${escapeHtml(risk.status)}</small></div>
      <div><strong>${escapeHtml(risk.target)}</strong><p>${escapeHtml(risk.summary)}</p><small class="risk-action">下一步：${escapeHtml(risk.nextAction)}</small></div>
    </article>
  `).join("");
}

function renderModules(modules) {
  $("#module-table").innerHTML = `
    <div class="module-row module-row--head" role="row"><span>模块</span><span>状态</span><span>最近修改</span><span>Tests</span><span>风险</span></div>
    ${modules.map((module) => `
      <div class="module-row" role="row">
        <strong>${escapeHtml(module.name)}</strong>
        <span>${renderStatus(module.status)}</span>
        <span class="muted-cell">${formatAge(module.lastModified)}</span>
        <span class="coverage-cell"><b>${module.tests.coverage}%</b><i style="width: ${module.tests.coverage}%"></i></span>
        <span class="risk-level risk-level--${escapeHtml(module.risk)}">${escapeHtml(module.risk)}</span>
      </div>
    `).join("")}
  `;
}

function renderChangelog(changelog) {
  $("#changelog-period").textContent = `${changelog.period.from} → ${changelog.period.to}`;
  $("#changelog-list").innerHTML = changelog.entries.map((entry) => `
    <article class="news-item">
      <div class="news-scope">${escapeHtml(entry.scope)}</div>
      <div><strong>${escapeHtml(entry.title)}</strong><ul>${entry.bullets.map((bullet) => `<li>${escapeHtml(bullet)}</li>`).join("")}</ul><small>${entry.commits.map(escapeHtml).join(" · ")}</small></div>
    </article>
  `).join("");
}

function renderArchitecture(architecture, decisions) {
  $("#architecture-map").innerHTML = architecture.layers.map((layer, index) => `
    <div class="architecture-layer">
      <span class="architecture-index">0${index + 1}</span>
      <div><strong>${escapeHtml(layer.label)}</strong><p>${escapeHtml(layer.description)}</p></div>
    </div>
  `).join("");
  $("#decision-list").innerHTML = `
    <div class="subsection-label">RECENT DECISIONS</div>
    ${decisions.decisions.map((decision) => `<article class="decision-item"><span>${escapeHtml(decision.id)}</span><strong>${escapeHtml(decision.title)}</strong><p>${escapeHtml(decision.summary)}</p></article>`).join("")}
  `;
}

function renderSnapshot(snapshot) {
  $("#snapshot-detail").textContent = `${snapshot.observedCommit} · ${formatDate(snapshot.generatedAt)} · ${snapshot.sourceCoverage.fieldAcceptance ? "field acceptance observed" : "field acceptance missing"}`;
}

function renderOverview(data) {
  renderProject(data);
  renderStaleness(data.snapshot);
  renderRoadmap(data.project.roadmap);
  renderNow(data.project.now);
  renderTasks(data.tasks.tasks);
  renderRisks(data.risks.risks);
  renderModules(data.modules.modules);
  renderChangelog(data.changelog);
  renderArchitecture(data.architecture, data.decisions);
  renderSnapshot(data.snapshot);
  $("#overview").classList.remove("is-hidden");
  debugBus.publish("overview:render-complete", { moduleCount: data.modules.modules.length });
}

function renderError(error) {
  const errorState = $("#error-state");
  const isFileProtocol = window.location.protocol === "file:";
  const hint = isFileProtocol
    ? "请从项目根目录启动本地静态服务器，再打开 http://localhost:8080/overview/。浏览器不会允许 file:// 页面读取相邻 JSON。"
    : "请检查 .overview 目录中的 JSON 文件是否存在且格式有效。";
  errorState.classList.remove("is-hidden");
  errorState.innerHTML = `<strong>地图加载失败</strong><p>${escapeHtml(error.message)}</p><small>${hint}</small>`;
  debugBus.publish("overview:load-error", { message: error.message });
}

loadOverview().then(renderOverview).catch(renderError);
