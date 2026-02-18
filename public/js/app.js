/* ===== API Helpers ===== */
const API = {
  async request(url, opts = {}) {
    try {
      const res = await fetch(url, {
        headers: { "Content-Type": "application/json", ...opts.headers },
        ...opts,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      if (res.status === 204) return null;
      return res.json();
    } catch (err) {
      Toast.error(err.message || "Network error");
      throw err;
    }
  },

  get(url)          { return this.request(url); },
  post(url, data)   { return this.request(url, { method: "POST", body: JSON.stringify(data) }); },
  put(url, data)    { return this.request(url, { method: "PUT", body: JSON.stringify(data) }); },
  del(url)          { return this.request(url, { method: "DELETE" }); },
};

/* ===== Toast ===== */
const Toast = {
  _container: null,

  _getContainer() {
    if (!this._container) {
      this._container = document.createElement("div");
      this._container.className = "toast-container";
      document.body.appendChild(this._container);
    }
    return this._container;
  },

  show(message, type = "info", duration = 3000) {
    const el = document.createElement("div");
    el.className = `toast toast-${type}`;
    el.textContent = message;
    this._getContainer().appendChild(el);
    setTimeout(() => {
      el.style.opacity = "0";
      el.style.transition = "opacity 0.3s";
      setTimeout(() => el.remove(), 300);
    }, duration);
  },

  success(msg) { this.show(msg, "success"); },
  error(msg)   { this.show(msg, "error", 5000); },
  info(msg)    { this.show(msg, "info"); },
};

/* ===== Meetings ===== */
async function fetchMeetings() {
  const tbody = document.getElementById("meetings-tbody");
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="4" class="loading">Loading...</td></tr>';

  try {
    const meetings = await API.get("/api/meetings");
    if (!meetings || meetings.length === 0) {
      tbody.innerHTML = '<tr><td colspan="4" class="empty-state"><i class="fa fa-inbox"></i>No meetings yet</td></tr>';
      return;
    }
    meetings.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
    tbody.innerHTML = meetings.map(m => meetingRow(m)).join("");
  } catch (_) {
    tbody.innerHTML = '<tr><td colspan="4" class="empty-state">Failed to load meetings</td></tr>';
  }
}

function meetingRow(m) {
  const title = escapeHtml(m.title || m.meetingId);
  const time = m.createdAt ? new Date(m.createdAt).toLocaleString("zh-CN") : "-";
  const status = m.status || "pending";
  const badgeClass = `badge badge-${status}`;
  const statusLabel = { pending: "Pending", transcribed: "Transcribed", reported: "Reported", completed: "Completed", created: "Created" }[status] || status;

  return `<tr>
    <td><a href="meeting.html?id=${encodeURIComponent(m.meetingId)}">${title}</a></td>
    <td>${time}</td>
    <td><span class="${badgeClass}">${statusLabel}</span></td>
    <td>
      <div class="btn-group">
        <a href="meeting.html?id=${encodeURIComponent(m.meetingId)}" class="btn btn-outline btn-sm"><i class="fa fa-eye"></i> View</a>
        ${status === "completed" ? `<button class="btn btn-success btn-sm" onclick="downloadPdf('${m.meetingId}')"><i class="fa fa-download"></i> PDF</button>` : ""}
        <button class="btn btn-danger btn-sm" onclick="deleteMeeting('${m.meetingId}')"><i class="fa fa-trash"></i></button>
      </div>
    </td>
  </tr>`;
}

async function deleteMeeting(id) {
  if (!confirm("Are you sure you want to delete this meeting?")) return;
  try {
    await API.del(`/api/meetings/${id}`);
    Toast.success("Meeting deleted");
    fetchMeetings();
  } catch (_) { /* error already shown by API */ }
}

function downloadPdf(id) {
  Toast.info("PDF download is handled by the export worker. Check your email.");
}

/* ===== File Upload ===== */
function initUpload() {
  const area = document.getElementById("upload-area");
  const input = document.getElementById("upload-input");
  const progress = document.getElementById("upload-progress");
  const bar = document.getElementById("progress-bar");
  const text = document.getElementById("progress-text");

  if (!area) return;

  area.addEventListener("dragover", e => {
    e.preventDefault();
    area.classList.add("dragover");
  });

  area.addEventListener("dragleave", () => {
    area.classList.remove("dragover");
  });

  area.addEventListener("drop", e => {
    e.preventDefault();
    area.classList.remove("dragover");
    const file = e.dataTransfer.files[0];
    if (file) uploadFile(file);
  });

  input.addEventListener("change", () => {
    const file = input.files[0];
    if (file) uploadFile(file);
    input.value = "";
  });
}

async function uploadFile(file) {
  const validTypes = ["video/mp4", "audio/mpeg", "audio/mp3", "audio/mp4", "video/quicktime"];
  const ext = file.name.split(".").pop().toLowerCase();
  if (!validTypes.includes(file.type) && !["mp4", "mp3", "m4a"].includes(ext)) {
    Toast.error("Please upload MP4 or MP3 files only.");
    return;
  }

  const progress = document.getElementById("upload-progress");
  const bar = document.getElementById("progress-bar");
  const text = document.getElementById("progress-text");

  progress.classList.add("show");
  bar.style.width = "0%";
  text.textContent = "Uploading...";

  const formData = new FormData();
  formData.append("file", file);
  formData.append("title", file.name.replace(/\.[^.]+$/, ""));

  try {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/meetings/upload");

    xhr.upload.addEventListener("progress", e => {
      if (e.lengthComputable) {
        const pct = Math.round((e.loaded / e.total) * 100);
        bar.style.width = pct + "%";
        text.textContent = `Uploading... ${pct}%`;
      }
    });

    const result = await new Promise((resolve, reject) => {
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(JSON.parse(xhr.responseText));
        } else {
          const body = JSON.parse(xhr.responseText || "{}");
          reject(new Error(body.error || `Upload failed (${xhr.status})`));
        }
      };
      xhr.onerror = () => reject(new Error("Network error"));
      xhr.send(formData);
    });

    bar.style.width = "100%";
    text.textContent = "Upload complete!";
    Toast.success("File uploaded. Transcription has started.");
    setTimeout(() => {
      progress.classList.remove("show");
      fetchMeetings();
    }, 1500);
  } catch (err) {
    text.textContent = "Upload failed";
    Toast.error(err.message);
    setTimeout(() => progress.classList.remove("show"), 3000);
  }
}

/* ===== Meeting Detail ===== */
async function fetchMeeting(id) {
  const content = document.getElementById("meeting-content");
  if (!content) return;
  content.innerHTML = '<div class="loading">Loading...</div>';

  try {
    const m = await API.get(`/api/meetings/${id}`);
    renderMeetingDetail(m);
  } catch (_) {
    content.innerHTML = '<div class="empty-state">Failed to load meeting details.</div>';
  }
}

function renderMeetingDetail(m) {
  const content = document.getElementById("meeting-content");
  const report = m.content || {};
  const title = escapeHtml(m.title || m.meetingId);
  const time = m.createdAt ? new Date(m.createdAt).toLocaleString("zh-CN") : "-";
  const status = m.status || "pending";
  const badgeClass = `badge badge-${status}`;
  const statusLabel = { pending: "Pending", transcribed: "Transcribed", reported: "Reported", completed: "Completed", created: "Created" }[status] || status;

  const highlights = report.highlights || [];
  const lowlights = report.lowlights || [];
  const actions = report.actions || [];
  const summary = report.summary || "No summary available yet.";

  content.innerHTML = `
    <div class="meeting-header">
      <div>
        <h1>${title}</h1>
        <div class="meeting-meta">${time} &nbsp; <span class="${badgeClass}">${statusLabel}</span></div>
      </div>
    </div>

    <div class="section-grid">
      <div class="card">
        <div class="card-title"><i class="fa fa-thumb-tack"></i> Highlights</div>
        ${highlights.length
          ? `<ul>${highlights.map(h => `<li>${escapeHtml(typeof h === "string" ? h : h.text || JSON.stringify(h))}</li>`).join("")}</ul>`
          : '<div class="empty-state">No highlights</div>'}
      </div>

      <div class="card">
        <div class="card-title"><i class="fa fa-exclamation-triangle"></i> Lowlights</div>
        ${lowlights.length
          ? `<ul>${lowlights.map(l => `<li>${escapeHtml(typeof l === "string" ? l : l.text || JSON.stringify(l))}</li>`).join("")}</ul>`
          : '<div class="empty-state">No lowlights</div>'}
      </div>
    </div>

    <div class="card">
      <div class="card-title"><i class="fa fa-check-square"></i> Follow-up Actions</div>
      ${actions.length ? `
      <div class="table-wrap">
        <table>
          <thead><tr><th>Task</th><th>Owner</th><th>Deadline</th><th>Priority</th></tr></thead>
          <tbody>
            ${actions.map(a => {
              const pClass = (a.priority || "").toLowerCase();
              return `<tr>
                <td>${escapeHtml(a.task || a.action || "")}</td>
                <td>${escapeHtml(a.owner || a.assignee || "-")}</td>
                <td>${escapeHtml(a.deadline || a.dueDate || "-")}</td>
                <td><span class="priority-${pClass}">${escapeHtml(a.priority || "-")}</span></td>
              </tr>`;
            }).join("")}
          </tbody>
        </table>
      </div>` : '<div class="empty-state">No actions</div>'}
    </div>

    <div class="card">
      <div class="card-title"><i class="fa fa-file-text"></i> Summary</div>
      <div class="summary-text">${escapeHtml(summary)}</div>
    </div>
  `;

  // Bottom bar buttons
  const bottomBar = document.getElementById("bottom-bar");
  if (bottomBar) {
    bottomBar.innerHTML = `
      <a href="index.html" class="btn btn-outline"><i class="fa fa-arrow-left"></i> Back to list</a>
      <div class="btn-group">
        <button class="btn btn-primary" onclick="downloadPdf('${m.meetingId}')"><i class="fa fa-download"></i> Download PDF</button>
        <button class="btn btn-warning" onclick="sendEmail('${m.meetingId}')"><i class="fa fa-envelope"></i> Send Email</button>
      </div>
    `;
  }
}

function sendEmail(id) {
  Toast.info("Email sending is handled by the export worker.");
}

/* ===== Glossary ===== */
let glossaryData = [];

async function fetchGlossary() {
  const tbody = document.getElementById("glossary-tbody");
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="4" class="loading">Loading...</td></tr>';

  try {
    glossaryData = await API.get("/api/glossary") || [];
    renderGlossary(glossaryData);
  } catch (_) {
    tbody.innerHTML = '<tr><td colspan="4" class="empty-state">Failed to load glossary</td></tr>';
  }
}

function renderGlossary(terms) {
  const tbody = document.getElementById("glossary-tbody");
  if (!terms || terms.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" class="empty-state"><i class="fa fa-book"></i>No terms yet</td></tr>';
    return;
  }
  tbody.innerHTML = terms.map(t => {
    const term = escapeHtml(t.term || "");
    const aliases = escapeHtml(t.aliases || "");
    const definition = escapeHtml(t.definition || "");
    return `<tr>
      <td><strong>${term}</strong></td>
      <td>${aliases}</td>
      <td>${definition}</td>
      <td>
        <div class="btn-group">
          <button class="btn btn-outline btn-sm" onclick="editTerm('${t.termId}')"><i class="fa fa-pencil"></i></button>
          <button class="btn btn-danger btn-sm" onclick="deleteTerm('${t.termId}')"><i class="fa fa-trash"></i></button>
        </div>
      </td>
    </tr>`;
  }).join("");
}

function filterGlossary(query) {
  const q = query.toLowerCase();
  const filtered = glossaryData.filter(t =>
    (t.term || "").toLowerCase().includes(q) ||
    (t.aliases || "").toLowerCase().includes(q) ||
    (t.definition || "").toLowerCase().includes(q)
  );
  renderGlossary(filtered);
}

async function addTerm(e) {
  e.preventDefault();
  const form = e.target;
  const data = {
    term: form.term.value.trim(),
    aliases: form.aliases.value.trim(),
    definition: form.definition.value.trim(),
  };
  if (!data.term) { Toast.error("Term name is required"); return; }

  try {
    await API.post("/api/glossary", data);
    Toast.success("Term added");
    form.reset();
    fetchGlossary();
  } catch (_) { /* error shown */ }
}

async function deleteTerm(id) {
  if (!confirm("Delete this term?")) return;
  try {
    await API.del(`/api/glossary/${id}`);
    Toast.success("Term deleted");
    fetchGlossary();
  } catch (_) {}
}

function editTerm(id) {
  const term = glossaryData.find(t => t.termId === id);
  if (!term) return;

  const overlay = document.getElementById("edit-modal");
  if (!overlay) return;

  document.getElementById("edit-term").value = term.term || "";
  document.getElementById("edit-aliases").value = term.aliases || "";
  document.getElementById("edit-definition").value = term.definition || "";
  overlay.dataset.termId = id;
  overlay.classList.add("show");
}

async function saveEditTerm(e) {
  e.preventDefault();
  const overlay = document.getElementById("edit-modal");
  const id = overlay.dataset.termId;

  const data = {
    term: document.getElementById("edit-term").value.trim(),
    definition: document.getElementById("edit-definition").value.trim(),
  };

  try {
    await API.put(`/api/glossary/${id}`, data);
    Toast.success("Term updated");
    overlay.classList.remove("show");
    fetchGlossary();
  } catch (_) {}
}

function closeModal() {
  const overlay = document.getElementById("edit-modal");
  if (overlay) overlay.classList.remove("show");
}

/* ===== Utils ===== */
function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function getParam(name) {
  return new URLSearchParams(window.location.search).get(name);
}
