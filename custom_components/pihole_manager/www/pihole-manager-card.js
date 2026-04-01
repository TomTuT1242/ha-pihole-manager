/**
 * Pi-hole Manager Card — Unified Dashboard for Home Assistant
 * Shows all Pi-hole instances as one, with expandable per-instance details
 * and an admin section for managing domains, DNS records, and blocklists.
 */

class PiholeManagerCard extends HTMLElement {
  set hass(hass) {
    this._hass = hass;
    if (!this._eventSubscribed && hass.connection) {
      this._eventSubscribed = true;
      hass.connection.subscribeEvents((ev) => {
        const data = ev.data || {};
        if (data.action === "sync_all") {
          this._lastSyncTime = new Date();
          const failCount = (data.failed || []).length;
          const successCount = (data.success || []).length;
          this._lastSyncStatus = failCount === 0 ? "success" : (successCount > 0 ? "partial" : "failed");
          this._updateLastSync();
        }
      }, "pihole_manager_sync_result");
    }
    if (!this._rendered) {
      this._render();
      this._rendered = true;
      this._update();
      return;
    }
    // Targeted update — only refresh values, don't rebuild DOM
    this._updateValues();
  }

  async _callServiceWithResponse(service, data) {
    const resp = await this._hass.fetchWithAuth(
      `/api/services/pihole_manager/${service}?return_response`,
      { method: "POST", body: JSON.stringify(data || {}) }
    );
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const json = await resp.json();
    return json.service_response || {};
  }

  setConfig(config) {
    this._config = config || {};
  }

  getCardSize() {
    return 5;
  }

  // ── State ──────────────────────────────────────────────

  _initState() {
    if (this._stateInit) return;
    this._stateInit = true;
    this._expanded = false;
    this._adminOpen = false;
    this._openCategory = null; // "denied" | "allowed" | "dns" | "blocklists"
    this._feedback = null; // {type: "success"|"error", message: "..."}
    this._feedbackTimer = null;
    this._topBlockedData = null;
    this._topBlockedTime = null;
    this._topBlockedLoading = false;
    this._dnsCompareData = null;
    this._dnsCompareLoading = false;
    this._recentQueriesData = null;
    this._recentQueriesTime = null;
    this._recentQueriesLoading = false;
    this._recentQueriesOpen = false;
    this._recentQueriesFilterBlocked = false;
    this._topBlockedOpen = false;
    this._queriesOpen = false;
    this._lastSyncTime = null;
    this._lastSyncStatus = null; // "success" | "partial" | "failed"
    this._lastListHash = null; // hash of list data to detect changes
  }

  // ── Discover entities by entity_id pattern ─────────────

  _getInstances() {
    if (!this._hass) return [];
    const entities = Object.keys(this._hass.states);

    const blockingSwitches = entities.filter(
      (e) => e.match(/^switch\.pi_hole[a-z0-9_]*_blocking$/)
    );

    const keyMap = {
      anfragen_gesamt: "queries_total", queries_total: "queries_total",
      anfragen_blockiert: "queries_blocked", queries_blocked: "queries_blocked",
      prozent_blockiert: "percent_blocked", percent_blocked: "percent_blocked",
      domains_auf_blockliste: "domains_blocked", domains_on_blocklist: "domains_blocked",
      blocklisten: "blocklists", blocklists: "blocklists",
      geblockte_domains: "denied_domains", denied_domains: "denied_domains",
      erlaubte_domains: "allowed_domains", allowed_domains: "allowed_domains",
      lokale_dns_eintrage: "dns_records", local_dns_records: "dns_records",
    };

    const instances = {};

    for (const sw of blockingSwitches) {
      const match = sw.match(/^switch\.(pi_hole[a-z0-9_]*)_blocking$/);
      if (!match) continue;
      const prefix = match[1];
      const friendly = this._hass.states[sw]?.attributes?.friendly_name || prefix;
      const deviceName = friendly.replace(" Blocking", "");

      instances[prefix] = { name: deviceName, prefix, switch: sw, sensors: {} };

      for (const eid of entities) {
        if (!eid.startsWith("sensor." + prefix + "_")) continue;
        const suffix = eid.replace("sensor." + prefix + "_", "");
        const canonicalKey = keyMap[suffix];
        if (canonicalKey) instances[prefix].sensors[canonicalKey] = eid;
      }
    }

    return Object.values(instances);
  }

  _val(entityId) {
    if (!this._hass || !entityId) return null;
    const s = this._hass.states[entityId];
    if (!s || s.state === "unavailable" || s.state === "unknown") return null;
    return s.state;
  }

  _numVal(entityId) {
    const v = this._val(entityId);
    return v !== null ? parseFloat(v) : null;
  }

  _attrs(entityId) {
    if (!this._hass || !entityId) return {};
    return this._hass.states[entityId]?.attributes || {};
  }

  // ── Get raw list data from first instance ──────────────

  _getListData(instances) {
    if (!instances.length) return { denied: [], allowed: [], dns: [], cnames: [], blocklists: [] };
    const first = instances[0];
    const dnsAttrs = this._attrs(first.sensors.dns_records) || {};
    return {
      denied: this._attrs(first.sensors.denied_domains)?.items || [],
      allowed: this._attrs(first.sensors.allowed_domains)?.items || [],
      dns: dnsAttrs.items || [],
      cnames: dnsAttrs.cname_items || [],
      blocklists: this._attrs(first.sensors.blocklists)?.items || [],
    };
  }

  // ── Aggregation ────────────────────────────────────────

  _getUnifiedStats(instances) {
    let totalQueries = 0, totalBlocked = 0, totalDomains = 0;
    let totalLists = 0, totalDenied = 0, totalAllowed = 0, totalDns = 0;
    let allBlocking = true, anyBlocking = false;
    let count = 0;

    for (const inst of instances) {
      const q = this._numVal(inst.sensors.queries_total);
      const b = this._numVal(inst.sensors.queries_blocked);
      const d = this._numVal(inst.sensors.domains_blocked);
      const lists = this._numVal(inst.sensors.blocklists);
      const denied = this._numVal(inst.sensors.denied_domains);
      const allowed = this._numVal(inst.sensors.allowed_domains);
      const dns = this._numVal(inst.sensors.dns_records);

      if (q !== null) totalQueries += q;
      if (b !== null) totalBlocked += b;
      if (d !== null) totalDomains = Math.max(totalDomains, d);
      if (lists !== null) totalLists = Math.max(totalLists, lists);
      if (denied !== null) totalDenied = Math.max(totalDenied, denied);
      if (allowed !== null) totalAllowed = Math.max(totalAllowed, allowed);
      if (dns !== null) totalDns = Math.max(totalDns, dns);

      if (inst.switch) {
        const isOn = this._val(inst.switch) === "on";
        if (!isOn) allBlocking = false;
        if (isOn) anyBlocking = true;
      }
      count++;
    }

    const percentBlocked = totalQueries > 0
      ? Math.round((totalBlocked / totalQueries) * 1000) / 10 : 0;

    return { queries: totalQueries, blocked: totalBlocked, percent: percentBlocked,
      domains: totalDomains, lists: totalLists, denied: totalDenied,
      allowed: totalAllowed, dns: totalDns, allBlocking, anyBlocking, count };
  }

  // ── Actions ────────────────────────────────────────────

  async _toggleMaster() {
    const instances = this._getInstances();
    const stats = this._getUnifiedStats(instances);
    const newState = !stats.allBlocking;
    for (const inst of instances) {
      if (!inst.switch) continue;
      const current = this._val(inst.switch) === "on";
      if (current !== newState) {
        await this._hass.callService("switch", newState ? "turn_on" : "turn_off",
          { entity_id: inst.switch });
      }
    }
  }

  async _toggleInstance(switchEntity) {
    if (!switchEntity) return;
    const isOn = this._val(switchEntity) === "on";
    await this._hass.callService("switch", isOn ? "turn_off" : "turn_on",
      { entity_id: switchEntity });
  }

  async _callService(service, data) {
    try {
      await this._hass.callService("pihole_manager", service, data);
      this._showFeedback("success", "Auf alle Instanzen angewendet");
    } catch (err) {
      this._showFeedback("error", "Fehler: " + err.message);
    }
  }

  _updateLastSync() {
    const el = this.shadowRoot?.getElementById("lastSyncValue");
    const card = this.shadowRoot?.getElementById("lastSyncCard");
    if (!el) return;
    if (this._lastSyncTime) {
      el.textContent = this._lastSyncTime.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" }) + " Uhr";
      if (card) {
        card.style.borderColor = this._lastSyncStatus === "failed" ? "var(--red)" : "";
        el.style.color = this._lastSyncStatus === "failed" ? "var(--red)" : "";
      }
    }
  }

  _showFeedback(type, message) {
    this._feedback = { type, message };
    if (this._feedbackTimer) clearTimeout(this._feedbackTimer);
    this._feedbackTimer = setTimeout(() => {
      this._feedback = null;
      this._updateFeedback();
    }, 3000);
    this._updateFeedback();
  }

  _formatCount(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
    if (n >= 1000) return (n / 1000).toFixed(1) + "K";
    return n.toLocaleString("de-DE");
  }

  _updateTopBlocked() {
    if (!this.shadowRoot) return;
    const container = this.shadowRoot.getElementById("topBlockedContent");
    if (!container) return;

    if (this._topBlockedLoading) {
      container.innerHTML = `<button class="top-blocked-btn" disabled><span class="tb-spinner"></span>Analysiere...</button>`;
      return;
    }

    if (!this._topBlockedData) {
      container.innerHTML = `<button class="top-blocked-btn" id="topBlockedBtn">Jetzt analysieren</button>`;
      this._bindTopBlockedBtn();
      return;
    }

    const timeStr = this._topBlockedTime
      ? this._topBlockedTime.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) + " Uhr"
      : "";

    const limited = this._topBlockedData.slice(0, 20);
    container.innerHTML = `
      <button class="top-blocked-btn" id="topBlockedBtn">Aktualisieren</button>
      ${timeStr ? `<div class="top-blocked-time">Abgerufen: ${timeStr}</div>` : ""}
      <ul class="top-blocked-list">
        ${limited.map((d, i) => `
          <li class="top-blocked-item">
            <span class="tb-rank">${i + 1}.</span>
            <span class="tb-domain" title="${this._esc(d.domain)}">${this._esc(d.domain)}</span>
            <span class="tb-count">${this._formatCount(d.count)}</span>
          </li>`).join("")}
      </ul>
    `;
    this._bindTopBlockedBtn();
  }

  _bindTopBlockedBtn() {
    const btn = this.shadowRoot?.getElementById("topBlockedBtn");
    if (!btn) return;
    btn.addEventListener("click", async () => {
      this._topBlockedLoading = true;
      this._updateTopBlocked();
      try {
        const data = await this._callServiceWithResponse("get_top_blocked", { count: 20 });
        this._topBlockedData = data.domains || [];
        this._topBlockedTime = new Date();
      } catch (err) {
        this._showFeedback("error", "Top Blocked Fehler: " + err.message);
      }
      this._topBlockedLoading = false;
      this._updateTopBlocked();
    });
  }

  _updateRecentQueries() {
    if (!this.shadowRoot) return;
    const container = this.shadowRoot.getElementById("recentQueriesContent");
    if (!container) return;

    if (this._recentQueriesLoading) {
      container.innerHTML = `<button class="top-blocked-btn" disabled><span class="tb-spinner"></span>Lade...</button>`;
      return;
    }

    if (!this._recentQueriesData) {
      container.innerHTML = `<button class="top-blocked-btn" id="recentQueriesBtn">Letzte Anfragen laden</button>`;
      this._bindRecentQueriesBtn();
      return;
    }

    const timeStr = this._recentQueriesTime
      ? this._recentQueriesTime.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) + " Uhr"
      : "";

    // Filter: PTR raus, optional nur Blocked
    let filtered = this._recentQueriesData.filter(q => !q.domain.endsWith('.in-addr.arpa'));
    if (this._recentQueriesFilterBlocked) {
      filtered = filtered.filter(q => q.blocked);
    }
    const sorted = filtered.sort((a, b) => b.time - a.time).slice(0, 30);
    container.innerHTML = `
      <button class="top-blocked-btn" id="recentQueriesBtn">Aktualisieren</button>
      <div class="rq-toolbar">
        <div class="top-blocked-time">Abgerufen: ${timeStr}</div>
        <label class="rq-filter-label">
          <input type="checkbox" id="rqFilterBlocked" ${this._recentQueriesFilterBlocked ? "checked" : ""} /> Nur geblockte
        </label>
      </div>
      <ul class="rq-list">
        ${sorted.map(q => {
          const blocked = q.blocked;
          const statusCls = blocked ? "blocked" : (q.status === "CACHE" ? "cached" : "allowed");
          const t = new Date(q.time * 1000);
          const timeStr2 = t.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
          return `
            <li class="rq-item ${blocked ? "is-blocked" : ""}">
              <span class="rq-status ${statusCls}"></span>
              <span class="rq-domain" title="${this._esc(q.domain)}">${this._esc(q.domain)}</span>
              <span class="rq-type">${this._esc(q.type)}</span>
              <span class="rq-client">${this._esc(q.client)}</span>
              <span class="rq-time">${timeStr2}</span>
            </li>`;
        }).join("")}
      </ul>
    `;
    this._bindRecentQueriesBtn();
    // Filter toggle handler
    this.shadowRoot?.getElementById("rqFilterBlocked")?.addEventListener("change", (e) => {
      this._recentQueriesFilterBlocked = e.target.checked;
      this._updateRecentQueries();
    });
  }

  _bindRecentQueriesBtn() {
    const btn = this.shadowRoot?.getElementById("recentQueriesBtn");
    if (!btn) return;
    btn.addEventListener("click", async () => {
      this._recentQueriesLoading = true;
      this._updateRecentQueries();
      try {
        const data = await this._callServiceWithResponse("get_recent_queries", { count: 100 });
        this._recentQueriesData = data.queries || [];
        this._recentQueriesTime = new Date();
      } catch (err) {
        this._showFeedback("error", "Recent Queries Fehler: " + err.message);
      }
      this._recentQueriesLoading = false;
      this._updateRecentQueries();
    });
  }

  _updateDnsCompare() {
    if (!this.shadowRoot) return;
    const container = this.shadowRoot.getElementById("dnsCompareContent");
    if (!container) return;

    if (this._dnsCompareLoading) {
      container.innerHTML = `<div style="text-align:center;padding:8px;"><span class="tb-spinner"></span> Vergleiche...</div>`;
      return;
    }

    if (!this._dnsCompareData) {
      container.innerHTML = "";
      return;
    }

    const { synced, unsynced } = this._dnsCompareData;
    const label = (r) => r.type === "CNAME" ? `${r.domain} \u2192 ${r.target}` : `${r.domain} (${r.ip})`;

    container.innerHTML = `
      ${unsynced.length > 0 ? `
        <div style="font-size:11px;color:var(--yellow);font-weight:600;margin:8px 0 4px;">Nicht synchron (${unsynced.length})</div>
        ${unsynced.map(r => `
          <div class="dns-compare-item unsynced">
            <span class="dc-icon">\u26A0</span>
            <span class="dc-type-badge">${r.type}</span>
            <span class="dc-text" title="Auf: ${(r.present_on||[]).join(', ')} | Fehlt: ${(r.missing_on||[]).join(', ')}">${this._esc(label(r))}</span>
            <span class="dc-info">fehlt auf ${(r.missing_on||[]).length}</span>
            <button class="dc-push" data-action="push_dns" data-type="${r.type}" data-ip="${this._esc(r.ip||'')}" data-domain="${this._esc(r.domain||'')}" data-target="${this._esc(r.target||'')}">pushen</button>
          </div>`).join("")}
        <button class="dns-sync-all-btn" id="dnsSyncAllBtn">\u21BB Alle fehlenden synchronisieren</button>
      ` : ""}
      ${synced.length > 0 ? `
        <div style="font-size:11px;color:var(--green);font-weight:600;margin:8px 0 4px;">Synchron (${synced.length})</div>
        ${synced.map(r => `
          <div class="dns-compare-item synced">
            <span class="dc-icon">\u2713</span>
            <span class="dc-type-badge">${r.type}</span>
            <span class="dc-text">${this._esc(label(r))}</span>
          </div>`).join("")}
      ` : ""}
      ${synced.length === 0 && unsynced.length === 0 ? '<div class="empty-list">Keine DNS Records gefunden</div>' : ""}
    `;

    // Bind push buttons
    container.querySelectorAll(".dc-push").forEach(btn => {
      btn.addEventListener("click", async () => {
        const { type, ip, domain, target } = btn.dataset;
        try {
          if (type === "A") {
            await this._hass.callService("pihole_manager", "add_dns_record", { ip, domain });
          } else {
            await this._hass.callService("pihole_manager", "add_dns_cname", { domain, target });
          }
          this._showFeedback("success", "Auf alle Instanzen angewendet");
          await new Promise(r => setTimeout(r, 2000));
          this._dnsCompareLoading = true;
          this._updateDnsCompare();
          this._dnsCompareData = await this._callServiceWithResponse("compare_dns_records", {});
        } catch (err) {
          this._showFeedback("error", "Fehler: " + err.message);
        }
        this._dnsCompareLoading = false;
        this._updateDnsCompare();
      });
    });

    // Bind sync-all button
    const syncAllBtn = container.querySelector("#dnsSyncAllBtn");
    if (syncAllBtn) {
      syncAllBtn.addEventListener("click", async () => {
        this._dnsCompareLoading = true;
        this._updateDnsCompare();
        try {
          await this._hass.callService("pihole_manager", "sync_dns_records", {});
          await new Promise(r => setTimeout(r, 2000));
          this._dnsCompareData = await this._callServiceWithResponse("compare_dns_records", {});
        } catch (err) {
          this._showFeedback("error", "Sync Fehler: " + err.message);
        }
        this._dnsCompareLoading = false;
        this._updateDnsCompare();
      });
    }
  }

  _updateFeedback() {
    if (!this.shadowRoot) return;
    const el = this.shadowRoot.getElementById("adminFeedback");
    if (!el) return;
    if (this._feedback) {
      el.className = "admin-feedback " + this._feedback.type;
      el.textContent = this._feedback.message;
      el.style.display = "block";
    } else {
      el.style.display = "none";
    }
  }

  // ── Render ─────────────────────────────────────────────

  _render() {
    this._initState();
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });

    this.shadowRoot.innerHTML = `
      <style>
        /* ── MonsterAdmin Design System v1 ──
         * Shared across: proxmox-dashboard, pihole-manager, ssl-admin
         * Status: green=#4caf50, orange=#ff9800, red=#f44336
         * All colors via HA CSS custom properties — Light+Dark compatible
         */
        :host {
          --text-primary: var(--primary-text-color, #212121);
          --text-secondary: var(--secondary-text-color, #727272);
          --accent: var(--primary-color, #03a9f4);
          --green: #4caf50;
          --red: #f44336;
          --yellow: #ff9800;
          --divider: var(--divider-color, rgba(0,0,0,0.12));
          --section-bg: var(--secondary-background-color, rgba(0,0,0,0.04));
          --hover-bg: var(--secondary-background-color, rgba(0,0,0,0.06));
        }
        ha-card { padding: 16px; overflow: hidden; font-family: inherit; }

        /* Header */
        .header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
        .header-left { display: flex; align-items: center; gap: 12px; }
        .logo { width: 40px; height: 40px; border-radius: 10px; background: linear-gradient(135deg, #96060b 0%, #d32f2f 100%); display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
        .title { font-size: 16px; font-weight: 600; color: var(--text-primary); }
        .subtitle { font-size: 12px; color: var(--text-secondary); }

        /* Toggle */
        .master-toggle { position: relative; width: 52px; height: 28px; border-radius: 14px; cursor: pointer; transition: background 0.3s; border: none; outline: none; padding: 0; }
        .master-toggle.on { background: var(--green); }
        .master-toggle.off { background: var(--red); }
        .master-toggle.partial { background: var(--yellow); }
        .master-toggle .knob { position: absolute; top: 3px; width: 22px; height: 22px; border-radius: 50%; background: white; transition: left 0.3s; box-shadow: 0 1px 3px rgba(0,0,0,0.3); }
        .master-toggle.on .knob { left: 27px; }
        .master-toggle.off .knob { left: 3px; }
        .master-toggle.partial .knob { left: 15px; }

        /* Status bar */
        .status-bar { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-radius: 8px; margin-bottom: 16px; font-size: 13px; font-weight: 500; }
        .status-bar.active { background: rgba(76, 175, 80, 0.15); color: var(--green); }
        .status-bar.inactive { background: rgba(244, 67, 54, 0.15); color: var(--red); }
        .status-bar.partial { background: rgba(255, 152, 0, 0.15); color: var(--yellow); }
        .status-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
        .status-bar.active .status-dot { background: var(--green); }
        .status-bar.inactive .status-dot { background: var(--red); }
        .status-bar.partial .status-dot { background: var(--yellow); }

        /* Stats */
        .stats-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 10px; }
        .stat-card { background: var(--section-bg); border: 1px solid var(--divider); border-radius: 10px; padding: 10px 12px; }
        .stat-value { font-size: 20px; font-weight: 700; color: var(--text-primary); line-height: 1.2; font-variant-numeric: tabular-nums; }
        .stat-label { font-size: 12px; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.5px; margin-top: 2px; }
        .stat-card.highlight { background: linear-gradient(135deg, rgba(3,169,244,0.15) 0%, rgba(3,169,244,0.05) 100%); border-color: rgba(3,169,244,0.2); }
        .stat-card.highlight .stat-value { color: var(--accent); }
        .secondary-stats { display: grid; grid-template-columns: 1fr 1fr 1fr 1fr; gap: 8px; margin-bottom: 10px; }
        .secondary-stat { text-align: center; padding: 6px 4px; background: var(--section-bg); border: 1px solid var(--divider); border-radius: 8px; }
        .secondary-stat .value { font-size: 14px; font-weight: 600; color: var(--text-primary); font-variant-numeric: tabular-nums; }
        .secondary-stat .label { font-size: 11px; color: var(--text-secondary); margin-top: 2px; }

        /* Expand buttons */
        .expand-btn { display: flex; align-items: center; justify-content: center; gap: 6px; width: 100%; padding: 8px; border: 1px solid var(--divider); border-radius: 8px; background: transparent; color: var(--text-secondary); font-size: 12px; font-family: inherit; cursor: pointer; transition: all 0.2s; margin-bottom: 8px; }
        .expand-btn:hover { background: var(--hover-bg); color: var(--text-primary); }
        .expand-btn .arrow { transition: transform 0.3s; font-size: 10px; }
        .expand-btn.open .arrow { transform: rotate(180deg); }

        /* Collapsible panels */
        .collapse-panel { max-height: 0; overflow: hidden; transition: max-height 0.4s ease; }
        .collapse-panel.open { max-height: 2000px; }

        /* Instances */
        .instance { margin-top: 12px; padding: 12px; border: 1px solid var(--divider); border-radius: 10px; background: var(--section-bg); }
        .instance-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
        .instance-name { font-size: 14px; font-weight: 600; color: var(--text-primary); display: flex; align-items: center; gap: 8px; }
        .instance-dot { width: 8px; height: 8px; border-radius: 50%; }
        .instance-dot.on { background: var(--green); }
        .instance-dot.off { background: var(--red); }
        .instance-toggle { width: 40px; height: 22px; border-radius: 11px; cursor: pointer; border: none; outline: none; padding: 0; position: relative; transition: background 0.3s; }
        .instance-toggle.on { background: var(--green); }
        .instance-toggle.off { background: var(--divider); }
        .instance-toggle .knob { position: absolute; top: 2px; width: 18px; height: 18px; border-radius: 50%; background: white; transition: left 0.3s; box-shadow: 0 1px 2px rgba(0,0,0,0.3); }
        .instance-toggle.on .knob { left: 20px; }
        .instance-toggle.off .knob { left: 2px; }
        .instance-stats { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 6px; }
        .instance-stat { font-size: 12px; color: var(--text-secondary); }
        .instance-stat strong { color: var(--text-primary); font-weight: 600; }

        /* WebUI link */
        .webui-link { display: block; text-align: right; font-size: 0.75em; color: var(--text-secondary); text-decoration: none; margin-top: 4px; opacity: 0.6; transition: opacity 0.2s; }
        .webui-link:hover { opacity: 1; text-decoration: underline; }

        /* Admin Section */
        .admin-divider { border: none; border-top: 1px solid var(--divider); margin: 12px 0 8px; }

        .category-btn { display: flex; align-items: center; gap: 10px; width: 100%; padding: 10px 12px; border: none; border-radius: 8px; background: transparent; color: var(--text-primary); font-size: 13px; font-family: inherit; cursor: pointer; transition: background 0.15s; text-align: left; }
        .category-btn:hover { background: var(--hover-bg); }
        .category-btn .cat-icon { font-size: 16px; width: 24px; text-align: center; flex-shrink: 0; }
        .category-btn .cat-label { flex: 1; font-weight: 500; }
        .category-btn .cat-count { color: var(--text-secondary); font-size: 12px; font-weight: 600; background: var(--section-bg); border: 1px solid var(--divider); padding: 2px 8px; border-radius: 10px; }
        .category-btn .cat-arrow { color: var(--text-secondary); font-size: 10px; transition: transform 0.3s; }
        .category-btn.open .cat-arrow { transform: rotate(90deg); }

        /* Category detail panel */
        .cat-detail { max-height: 0; overflow: hidden; transition: max-height 0.4s ease; }
        .cat-detail.open { max-height: 1500px; overflow-y: auto; }
        .cat-detail-inner { padding: 8px 0 8px 12px; }

        /* List items */
        .list-item { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 6px; font-size: 12px; color: var(--text-primary); transition: background 0.15s; }
        .list-item:hover { background: var(--hover-bg); }
        .list-item .item-text { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .list-item .item-comment { color: var(--text-secondary); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 120px; }
        .list-item .item-delete { background: none; border: none; color: var(--red); cursor: pointer; padding: 2px 4px; font-size: 14px; border-radius: 4px; opacity: 0.6; transition: opacity 0.15s; flex-shrink: 0; }
        .list-item .item-delete:hover { opacity: 1; background: rgba(244,67,54,0.15); }

        /* Blocklist toggle */
        .bl-toggle { width: 32px; height: 18px; border-radius: 9px; cursor: pointer; border: none; outline: none; padding: 0; position: relative; transition: background 0.3s; flex-shrink: 0; }
        .bl-toggle.on { background: var(--green); }
        .bl-toggle.off { background: var(--divider); }
        .bl-toggle .knob { position: absolute; top: 2px; width: 14px; height: 14px; border-radius: 50%; background: white; transition: left 0.2s; box-shadow: 0 1px 2px rgba(0,0,0,0.3); }
        .bl-toggle.on .knob { left: 16px; }
        .bl-toggle.off .knob { left: 2px; }

        /* Add row */
        .add-row { display: flex; gap: 6px; padding: 8px 0 4px; }
        .add-row input { flex: 1; padding: 6px 10px; border: 1px solid var(--divider); border-radius: 6px; background: transparent; color: var(--text-primary); font-size: 12px; font-family: inherit; outline: none; min-width: 0; }
        .add-row input:focus { border-color: var(--accent); }
        .add-row input::placeholder { color: var(--text-secondary); opacity: 0.6; }
        .add-row button { padding: 6px 12px; border: none; border-radius: 6px; background: var(--accent); color: white; font-size: 12px; font-family: inherit; font-weight: 600; cursor: pointer; white-space: nowrap; transition: opacity 0.15s; }
        .add-row button:hover { opacity: 0.85; }
        .add-row button:disabled { opacity: 0.4; cursor: not-allowed; }

        /* Subdomain checkbox */
        .subdomain-row { display: flex; align-items: center; gap: 6px; padding: 2px 0 4px; }
        .subdomain-row label { font-size: 11px; color: var(--text-secondary); cursor: pointer; user-select: none; display: flex; align-items: center; gap: 4px; }
        .subdomain-row input[type="checkbox"] { width: 14px; height: 14px; accent-color: var(--accent); cursor: pointer; }

        /* Sync button */
        .sync-row { margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--divider); }
        .sync-btn { display: flex; align-items: center; justify-content: center; gap: 8px; width: 100%; padding: 10px; border: 1px solid var(--accent); border-radius: 8px; background: transparent; color: var(--accent); font-size: 13px; font-family: inherit; font-weight: 500; cursor: pointer; transition: all 0.2s; }
        .sync-btn:hover { background: rgba(3,169,244,0.1); }

        /* Feedback */
        .admin-feedback { display: none; padding: 8px 12px; border-radius: 6px; font-size: 12px; font-weight: 500; margin-top: 8px; text-align: center; transition: opacity 0.3s; }
        .admin-feedback.success { background: rgba(76,175,80,0.15); color: var(--green); display: block; }
        .admin-feedback.error { background: rgba(244,67,54,0.15); color: var(--red); display: block; }

        /* Top Blocked / Recent Queries */
        .top-blocked-section { margin-top: 8px; padding: 12px; border: 1px solid var(--divider); border-radius: 10px; }
        .top-blocked-header { display: flex; align-items: center; gap: 8px; }
        .top-blocked-header .tb-icon { font-size: 16px; }
        .top-blocked-header .tb-title { font-size: 13px; font-weight: 600; color: var(--text-primary); flex: 1; }
        .tb-collapsible { background: none; border: none; cursor: pointer; width: 100%; padding: 0; text-align: left; font-family: inherit; }
        .tb-collapsible .cat-arrow { color: var(--text-secondary); font-size: 10px; transition: transform 0.3s; }
        .tb-collapsible.open .cat-arrow { transform: rotate(90deg); }
        .tb-collapse-panel { max-height: 0; overflow: hidden; transition: max-height 0.4s ease; }
        .tb-collapse-panel.open { max-height: 3000px; padding-top: 8px; }
        .top-blocked-btn { padding: 8px 16px; border: 1px solid var(--accent); border-radius: 8px; background: transparent; color: var(--accent); font-size: 12px; font-family: inherit; font-weight: 500; cursor: pointer; transition: all 0.2s; width: 100%; }
        .top-blocked-btn:hover { background: rgba(3,169,244,0.1); }
        .top-blocked-btn:disabled { opacity: 0.5; cursor: not-allowed; }
        .top-blocked-list { margin: 0; padding: 0; list-style: none; }
        .top-blocked-item { display: flex; align-items: center; gap: 8px; padding: 4px 0; font-size: 12px; border-bottom: 1px solid var(--divider); }
        .top-blocked-item:last-child { border-bottom: none; }
        .top-blocked-item .tb-rank { color: var(--text-secondary); font-size: 11px; width: 20px; text-align: right; flex-shrink: 0; }
        .top-blocked-item .tb-domain { flex: 1; color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .top-blocked-item .tb-count { color: var(--accent); font-weight: 600; font-variant-numeric: tabular-nums; flex-shrink: 0; }
        .top-blocked-time { font-size: 10px; color: var(--text-secondary); margin-top: 6px; }
        .tb-spinner { display: inline-block; width: 14px; height: 14px; border: 2px solid var(--accent); border-top-color: transparent; border-radius: 50%; animation: tb-spin 0.8s linear infinite; vertical-align: middle; margin-right: 6px; }
        @keyframes tb-spin { to { transform: rotate(360deg); } }

        /* Recent Queries */
        .rq-toolbar { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
        .rq-filter-label { display: flex; align-items: center; gap: 4px; color: var(--text-secondary); cursor: pointer; font-size: 12px; }
        .rq-filter-label input[type="checkbox"] { accent-color: var(--accent); }
        .rq-list { margin: 0; padding: 0; list-style: none; }
        .rq-item { display: flex; align-items: center; gap: 6px; padding: 3px 0; font-size: 12px; border-bottom: 1px solid var(--divider); }
        .rq-item:last-child { border-bottom: none; }
        .rq-item .rq-status { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
        .rq-item .rq-status.blocked { background: var(--red); }
        .rq-item .rq-status.allowed { background: var(--green); }
        .rq-item .rq-status.cached { background: var(--text-secondary); }
        .rq-item .rq-domain { flex: 1; color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .rq-item.is-blocked .rq-domain { color: var(--red); }
        .rq-item .rq-client { color: var(--text-secondary); font-size: 10px; font-variant-numeric: tabular-nums; flex-shrink: 0; }
        .rq-item .rq-time { color: var(--text-secondary); font-size: 10px; font-variant-numeric: tabular-nums; flex-shrink: 0; width: 42px; text-align: right; }
        .rq-item .rq-type { font-size: 9px; padding: 1px 3px; border-radius: 3px; background: var(--section-bg); border: 1px solid var(--divider); color: var(--text-secondary); flex-shrink: 0; }

        /* DNS Compare */
        .dns-compare-item { display: flex; align-items: center; gap: 6px; padding: 4px 8px; border-radius: 6px; font-size: 12px; margin-bottom: 2px; }
        .dns-compare-item.synced { color: var(--green); background: rgba(76,175,80,0.08); }
        .dns-compare-item.unsynced { color: var(--yellow); background: rgba(255,152,0,0.08); }
        .dns-compare-item .dc-icon { flex-shrink: 0; font-size: 11px; }
        .dns-compare-item .dc-text { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .dns-compare-item .dc-info { font-size: 10px; color: var(--text-secondary); flex-shrink: 0; }
        .dns-compare-item .dc-push { background: none; border: 1px solid var(--accent); color: var(--accent); cursor: pointer; padding: 2px 8px; font-size: 10px; font-family: inherit; border-radius: 4px; flex-shrink: 0; transition: all 0.15s; }
        .dns-compare-item .dc-push:hover { background: rgba(3,169,244,0.15); }
        .dns-sync-all-btn { margin-top: 6px; padding: 6px 12px; border: 1px solid var(--yellow); border-radius: 6px; background: transparent; color: var(--yellow); font-size: 11px; font-family: inherit; font-weight: 500; cursor: pointer; width: 100%; transition: all 0.15s; }
        .dns-sync-all-btn:hover { background: rgba(255,152,0,0.1); }
        .dc-type-badge { font-size: 9px; padding: 1px 4px; border-radius: 3px; background: var(--section-bg); border: 1px solid var(--divider); color: var(--text-secondary); flex-shrink: 0; font-weight: 600; }

        /* Empty state */
        .empty-list { color: var(--text-secondary); font-size: 12px; font-style: italic; padding: 8px 0; }
        .no-instances { text-align: center; padding: 32px 16px; color: var(--text-secondary); font-size: 14px; }
      </style>

      <ha-card>
        <div id="content"></div>
      </ha-card>
    `;
  }

  _formatNumber(num) {
    if (num === null || num === undefined) return "\u2014";
    if (num >= 1000000) return (num / 1000000).toFixed(1) + "M";
    if (num >= 1000) return (num / 1000).toFixed(1) + "K";
    return num.toLocaleString("de-DE");
  }

  _getListHash(instances) {
    const lists = this._getListData(instances);
    return JSON.stringify([
      lists.denied.map(d => d.domain).sort(),
      lists.allowed.map(d => d.domain).sort(),
      lists.dns.map(d => d.domain + d.ip).sort(),
      lists.cnames.map(d => d.domain + d.target).sort(),
      lists.blocklists.map(b => b.address + (b.enabled !== false)).sort(),
    ]);
  }

  _updateValues() {
    if (!this.shadowRoot) return;
    const sr = this.shadowRoot;
    const instances = this._getInstances();
    if (instances.length === 0) return;

    // Check if list data changed — if so, do a full re-render and restore dynamic data
    const listHash = this._getListHash(instances);
    if (this._lastListHash && listHash !== this._lastListHash) {
      this._lastListHash = listHash;
      this._update();
      // Restore dynamic data containers
      if (this._topBlockedData) this._updateTopBlocked();
      if (this._recentQueriesData) this._updateRecentQueries();
      if (this._dnsCompareData) this._updateDnsCompare();
      if (this._feedback) this._updateFeedback();
      return;
    }
    this._lastListHash = listHash;

    const stats = this._getUnifiedStats(instances);

    // Update stat values
    const statMap = [
      [".stats-grid .stat-card:nth-child(1) .stat-value", this._formatNumber(stats.queries)],
      [".stats-grid .stat-card:nth-child(2) .stat-value", this._formatNumber(stats.blocked)],
      [".stats-grid .stat-card:nth-child(3) .stat-value", this._formatNumber(stats.domains)],
    ];
    for (const [sel, val] of statMap) {
      const el = sr.querySelector(sel);
      if (el && el.textContent !== val) el.textContent = val;
    }
    // Blocked percent label
    const blockedLabel = sr.querySelector(".stats-grid .stat-card:nth-child(2) .stat-label");
    if (blockedLabel) {
      const txt = `Blockiert (${stats.percent}%)`;
      if (blockedLabel.textContent !== txt) blockedLabel.textContent = txt;
    }

    // Secondary stats
    const secValues = [stats.denied, stats.allowed, stats.dns, stats.count];
    sr.querySelectorAll(".secondary-stat .value").forEach((el, i) => {
      const v = String(secValues[i] ?? "");
      if (el.textContent !== v) el.textContent = v;
    });

    // Status bar
    const statusClass = stats.allBlocking ? "active" : stats.anyBlocking ? "partial" : "inactive";
    const statusBar = sr.querySelector(".status-bar");
    if (statusBar) {
      statusBar.className = "status-bar " + statusClass;
      const statusText = stats.allBlocking
        ? `${stats.count} Instanzen aktiv \u2014 Schutz l\u00e4uft`
        : stats.anyBlocking
          ? `Teilweise aktiv \u2014 ${stats.count} Instanzen`
          : `Blocking deaktiviert \u2014 ${stats.count} Instanzen`;
      const textNode = statusBar.lastChild;
      if (textNode && textNode.nodeType === 3 && textNode.textContent.trim() !== statusText.trim()) {
        textNode.textContent = "\n        " + statusText + "\n      ";
      }
    }

    // Master toggle
    const toggleClass = stats.allBlocking ? "on" : stats.anyBlocking ? "partial" : "off";
    const masterToggle = sr.getElementById("masterToggle");
    if (masterToggle) masterToggle.className = "master-toggle " + toggleClass;

    // Instance dots and toggles
    sr.querySelectorAll(".instance-toggle").forEach(btn => {
      const sw = btn.dataset.switch;
      const isOn = this._val(sw) === "on";
      btn.className = "instance-toggle " + (isOn ? "on" : "off");
    });
    sr.querySelectorAll(".instance").forEach((inst, i) => {
      if (i >= instances.length) return;
      const isOn = instances[i].switch ? this._val(instances[i].switch) === "on" : true;
      const dot = inst.querySelector(".instance-dot");
      if (dot) dot.className = "instance-dot " + (isOn ? "on" : "off");
      // Update instance stats
      const statEls = inst.querySelectorAll(".instance-stat strong");
      if (statEls.length >= 3) {
        const q = this._numVal(instances[i].sensors.queries_total);
        const b = this._numVal(instances[i].sensors.queries_blocked);
        const pct = this._numVal(instances[i].sensors.percent_blocked);
        statEls[0].textContent = this._formatNumber(q);
        statEls[1].textContent = this._formatNumber(b);
        statEls[2].textContent = pct !== null ? pct + "%" : "\u2014";
      }
    });

    // Update category count badges
    const lists = this._getListData(instances);
    const catCounts = { denied: lists.denied.length, allowed: lists.allowed.length, dns: lists.dns.length + lists.cnames.length, blocklists: lists.blocklists.length };
    sr.querySelectorAll(".category-btn").forEach(btn => {
      const cat = btn.dataset.cat;
      const countEl = btn.querySelector(".cat-count");
      if (countEl && catCounts[cat] !== undefined) {
        const v = String(catCounts[cat]);
        if (countEl.textContent !== v) countEl.textContent = v;
      }
    });
  }

  _update() {
    if (!this.shadowRoot) return;
    const content = this.shadowRoot.getElementById("content");
    if (!content) return;

    const instances = this._getInstances();

    if (instances.length === 0) {
      content.innerHTML = `<div class="no-instances">Keine Pi-hole Instanzen gefunden.<br><small>Pi-hole Manager Integration einrichten.</small></div>`;
      return;
    }

    const stats = this._getUnifiedStats(instances);
    const lists = this._getListData(instances);
    const statusClass = stats.allBlocking ? "active" : stats.anyBlocking ? "partial" : "inactive";
    const toggleClass = stats.allBlocking ? "on" : stats.anyBlocking ? "partial" : "off";
    const statusText = stats.allBlocking
      ? `${stats.count} Instanzen aktiv \u2014 Schutz l\u00e4uft`
      : stats.anyBlocking
        ? `Teilweise aktiv \u2014 ${stats.count} Instanzen`
        : `Blocking deaktiviert \u2014 ${stats.count} Instanzen`;

    content.innerHTML = `
      <div class="header">
        <div class="header-left">
          <div class="logo">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="white">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/>
            </svg>
          </div>
          <div>
            <div class="title">Pi-hole</div>
            <div class="subtitle">${stats.count} Instanz${stats.count !== 1 ? "en" : ""}</div>
          </div>
        </div>
        <button class="master-toggle ${toggleClass}" id="masterToggle"><div class="knob"></div></button>
      </div>

      <div class="status-bar ${statusClass}">
        <div class="status-dot"></div>
        ${statusText}
      </div>

      <div class="stats-grid">
        <div class="stat-card highlight">
          <div class="stat-value">${this._formatNumber(stats.queries)}</div>
          <div class="stat-label">Anfragen</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">${this._formatNumber(stats.blocked)}</div>
          <div class="stat-label">Blockiert (${stats.percent}%)</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">${this._formatNumber(stats.domains)}</div>
          <div class="stat-label">Domains auf Blockliste</div>
        </div>
        <div class="stat-card" id="lastSyncCard">
          <div class="stat-value" id="lastSyncValue">${this._lastSyncTime ? this._lastSyncTime.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" }) + " Uhr" : "\u2014"}</div>
          <div class="stat-label">Letzter Sync</div>
        </div>
      </div>

      <div class="secondary-stats">
        <div class="secondary-stat"><div class="value">${stats.denied}</div><div class="label">Denied</div></div>
        <div class="secondary-stat"><div class="value">${stats.allowed}</div><div class="label">Allowed</div></div>
        <div class="secondary-stat"><div class="value">${stats.dns}</div><div class="label">DNS</div></div>
        <div class="secondary-stat"><div class="value">${stats.count}</div><div class="label">Instanzen</div></div>
      </div>

      <!-- Instances toggle -->
      <button class="expand-btn ${this._expanded ? "open" : ""}" id="expandBtn">
        Instanzen anzeigen <span class="arrow">\u25BC</span>
      </button>

      <div class="collapse-panel ${this._expanded ? "open" : ""}" id="instancesPanel">
        ${instances.map((inst) => {
          const isOn = inst.switch ? this._val(inst.switch) === "on" : true;
          const q = this._numVal(inst.sensors.queries_total);
          const b = this._numVal(inst.sensors.queries_blocked);
          const pct = this._numVal(inst.sensors.percent_blocked);
          const webui = this._attrs(inst.sensors.queries_total)?.webui_url || "";
          return `
            <div class="instance">
              <div class="instance-header">
                <div class="instance-name">
                  <div class="instance-dot ${isOn ? "on" : "off"}"></div>
                  ${inst.name}
                </div>
                ${inst.switch ? `<button class="instance-toggle ${isOn ? "on" : "off"}" data-switch="${inst.switch}"><div class="knob"></div></button>` : ""}
              </div>
              <div class="instance-stats">
                <div class="instance-stat"><strong>${this._formatNumber(q)}</strong> Anfragen</div>
                <div class="instance-stat"><strong>${this._formatNumber(b)}</strong> Blockiert</div>
                <div class="instance-stat"><strong>${pct !== null ? pct + "%" : "\u2014"}</strong> Quote</div>
              </div>
              ${webui ? `<a href="${webui}" target="_blank" rel="noopener" class="webui-link">WebUI \u00f6ffnen \u2197</a>` : ""}
            </div>`;
        }).join("")}
      </div>

      <!-- Admin Section -->
      <hr class="admin-divider">

      <button class="expand-btn ${this._adminOpen ? "open" : ""}" id="adminBtn">
        Verwaltung <span class="arrow">\u25BC</span>
      </button>

      <div class="collapse-panel ${this._adminOpen ? "open" : ""}" id="adminPanel">

        <!-- Sync All — ganz oben in Verwaltung -->
        <div class="sync-row">
          <button class="sync-btn" id="syncAllBtn">
            \u21BB Alle Pi's synchronisieren
          </button>
        </div>
        <div class="admin-feedback" id="adminFeedback"></div>

        <!-- Denied Domains -->
        <button class="category-btn ${this._openCategory === "denied" ? "open" : ""}" data-cat="denied">
          <span class="cat-icon">\uD83D\uDEAB</span>
          <span class="cat-label">Denied Domains</span>
          <span class="cat-count">${lists.denied.length}</span>
          <span class="cat-arrow">\u25B6</span>
        </button>
        <div class="cat-detail ${this._openCategory === "denied" ? "open" : ""}" data-cat-detail="denied">
          <div class="cat-detail-inner">
            ${lists.denied.length === 0 ? '<div class="empty-list">Keine Eintr\u00e4ge</div>' :
              lists.denied.map(d => `
                <div class="list-item">
                  <span class="item-text">${this._esc(d.domain)}</span>
                  ${d.comment ? `<span class="item-comment" title="${this._esc(d.comment)}">${this._esc(d.comment)}</span>` : ""}
                  <button class="item-delete" data-action="remove_denied" data-domain="${this._esc(d.domain)}" title="Entfernen">\u2715</button>
                </div>`).join("")}
            <div class="add-row">
              <input type="text" placeholder="domain.example.com" id="addDeniedInput">
              <button id="addDeniedBtn">Blockieren</button>
            </div>
            <div class="subdomain-row">
              <label><input type="checkbox" id="addDeniedSubdomains" checked> inkl. Subdomains</label>
            </div>
          </div>
        </div>

        <!-- Allowed Domains -->
        <button class="category-btn ${this._openCategory === "allowed" ? "open" : ""}" data-cat="allowed">
          <span class="cat-icon">\u2705</span>
          <span class="cat-label">Allowed Domains</span>
          <span class="cat-count">${lists.allowed.length}</span>
          <span class="cat-arrow">\u25B6</span>
        </button>
        <div class="cat-detail ${this._openCategory === "allowed" ? "open" : ""}" data-cat-detail="allowed">
          <div class="cat-detail-inner">
            ${lists.allowed.length === 0 ? '<div class="empty-list">Keine Eintr\u00e4ge</div>' :
              lists.allowed.map(d => `
                <div class="list-item">
                  <span class="item-text">${this._esc(d.domain)}</span>
                  ${d.comment ? `<span class="item-comment" title="${this._esc(d.comment)}">${this._esc(d.comment)}</span>` : ""}
                  <button class="item-delete" data-action="remove_allowed" data-domain="${this._esc(d.domain)}" title="Entfernen">\u2715</button>
                </div>`).join("")}
            <div class="add-row">
              <input type="text" placeholder="domain.example.com" id="addAllowedInput">
              <button id="addAllowedBtn">Erlauben</button>
            </div>
            <div class="subdomain-row">
              <label><input type="checkbox" id="addAllowedSubdomains" checked> inkl. Subdomains</label>
            </div>
          </div>
        </div>

        <!-- DNS Records -->
        <button class="category-btn ${this._openCategory === "dns" ? "open" : ""}" data-cat="dns">
          <span class="cat-icon">\uD83C\uDF10</span>
          <span class="cat-label">DNS Records</span>
          <span class="cat-count">${lists.dns.length + lists.cnames.length}</span>
          <span class="cat-arrow">\u25B6</span>
        </button>
        <div class="cat-detail ${this._openCategory === "dns" ? "open" : ""}" data-cat-detail="dns">
          <div class="cat-detail-inner">
            <div style="font-size:11px;color:var(--text-secondary);font-weight:600;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">A-Records (${lists.dns.length})</div>
            ${lists.dns.length === 0 ? '<div class="empty-list">Keine Eintr\u00e4ge</div>' :
              lists.dns.map(d => `
                <div class="list-item">
                  <span class="item-text">${this._esc(d.domain)}</span>
                  <span class="item-comment">${this._esc(d.ip)}</span>
                  <button class="item-delete" data-action="remove_dns" data-ip="${this._esc(d.ip)}" data-domain="${this._esc(d.domain)}" title="Entfernen">\u2715</button>
                </div>`).join("")}
            <div class="add-row">
              <input type="text" placeholder="192.168.1.100" id="addDnsIpInput" style="max-width:130px;">
              <input type="text" placeholder="host.local" id="addDnsDomainInput">
              <button id="addDnsBtn">+</button>
            </div>

            <div style="font-size:11px;color:var(--text-secondary);font-weight:600;text-transform:uppercase;letter-spacing:0.5px;margin:12px 0 4px;padding-top:8px;border-top:1px solid var(--divider);">CNAME Records (${lists.cnames.length})</div>
            ${lists.cnames.length === 0 ? '<div class="empty-list">Keine Eintr\u00e4ge</div>' :
              lists.cnames.map(d => `
                <div class="list-item">
                  <span class="item-text">${this._esc(d.domain)}</span>
                  <span class="item-comment">\u2192 ${this._esc(d.target)}</span>
                  <button class="item-delete" data-action="remove_cname" data-domain="${this._esc(d.domain)}" data-target="${this._esc(d.target)}" title="Entfernen">\u2715</button>
                </div>`).join("")}
            <div class="add-row">
              <input type="text" placeholder="alias.local" id="addCnameDomainInput">
              <input type="text" placeholder="\u2192 target.local" id="addCnameTargetInput">
              <button id="addCnameBtn">+</button>
            </div>

            <div style="margin-top:10px;padding-top:8px;border-top:1px solid var(--divider);">
              <button class="top-blocked-btn" id="dnsCompareBtn">DNS Records vergleichen</button>
              <div id="dnsCompareContent"></div>
            </div>
          </div>
        </div>

        <!-- Blocklists -->
        <button class="category-btn ${this._openCategory === "blocklists" ? "open" : ""}" data-cat="blocklists">
          <span class="cat-icon">\uD83D\uDCCB</span>
          <span class="cat-label">Blocklisten</span>
          <span class="cat-count">${lists.blocklists.length}</span>
          <span class="cat-arrow">\u25B6</span>
        </button>
        <div class="cat-detail ${this._openCategory === "blocklists" ? "open" : ""}" data-cat-detail="blocklists">
          <div class="cat-detail-inner">
            ${lists.blocklists.length === 0 ? '<div class="empty-list">Keine Eintr\u00e4ge</div>' :
              lists.blocklists.map(bl => {
                const shortUrl = (bl.address || "").replace(/^https?:\/\//, "").substring(0, 50);
                const enabled = bl.enabled !== false;
                return `
                  <div class="list-item">
                    <button class="bl-toggle ${enabled ? "on" : "off"}" data-action="toggle_bl" data-id="${bl.id}" data-enabled="${enabled}"><div class="knob"></div></button>
                    <span class="item-text" title="${this._esc(bl.address)}">${this._esc(shortUrl)}${(bl.address||"").length > 50 ? "\u2026" : ""}</span>
                    <button class="item-delete" data-action="remove_bl" data-url="${this._esc(bl.address)}" title="Entfernen">\u2715</button>
                  </div>`;
              }).join("")}
            <div class="add-row">
              <input type="text" placeholder="https://blocklist-url..." id="addBlInput">
              <button id="addBlBtn">+</button>
            </div>
          </div>
        </div>

      </div>

      <!-- Abfragen Section -->
      <hr class="admin-divider">

      <button class="expand-btn ${this._queriesOpen ? "open" : ""}" id="queriesBtn">
        Abfragen <span class="arrow">\u25BC</span>
      </button>

      <div class="collapse-panel ${this._queriesOpen ? "open" : ""}" id="queriesPanel">

        <!-- Recent Queries -->
        <div class="top-blocked-section">
          <div class="top-blocked-header">
            <span class="tb-icon">\u23F1</span>
            <span class="tb-title">Recent Queries</span>
          </div>
          <div id="recentQueriesContent">
            <button class="top-blocked-btn" id="recentQueriesBtn">Letzte Anfragen laden</button>
          </div>
        </div>

        <!-- Top Blocked Domains -->
        <div class="top-blocked-section" style="margin-top:8px;">
          <div class="top-blocked-header">
            <span class="tb-icon">\uD83D\uDD0D</span>
            <span class="tb-title">Top Blocked Domains</span>
          </div>
          <div id="topBlockedContent">
            <button class="top-blocked-btn" id="topBlockedBtn">Jetzt analysieren</button>
          </div>
        </div>

      </div>
    `;

    this._bindEvents();
  }

  _esc(str) {
    if (!str) return "";
    const d = document.createElement("div");
    d.textContent = str;
    return d.innerHTML;
  }

  _bindEvents() {
    const sr = this.shadowRoot;

    // Master toggle
    sr.getElementById("masterToggle")?.addEventListener("click", () => this._toggleMaster());

    // Instances panel
    sr.getElementById("expandBtn")?.addEventListener("click", () => {
      this._expanded = !this._expanded;
      sr.getElementById("expandBtn")?.classList.toggle("open", this._expanded);
      sr.getElementById("instancesPanel")?.classList.toggle("open", this._expanded);
    });

    sr.querySelectorAll(".instance-toggle").forEach(btn =>
      btn.addEventListener("click", () => this._toggleInstance(btn.dataset.switch))
    );

    // Admin panel
    sr.getElementById("adminBtn")?.addEventListener("click", () => {
      this._adminOpen = !this._adminOpen;
      sr.getElementById("adminBtn")?.classList.toggle("open", this._adminOpen);
      sr.getElementById("adminPanel")?.classList.toggle("open", this._adminOpen);
    });

    // Abfragen panel
    sr.getElementById("queriesBtn")?.addEventListener("click", () => {
      this._queriesOpen = !this._queriesOpen;
      sr.getElementById("queriesBtn")?.classList.toggle("open", this._queriesOpen);
      sr.getElementById("queriesPanel")?.classList.toggle("open", this._queriesOpen);
    });

    // Category toggles
    sr.querySelectorAll(".category-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        const cat = btn.dataset.cat;
        const wasOpen = this._openCategory === cat;
        this._openCategory = wasOpen ? null : cat;
        // Update all categories
        sr.querySelectorAll(".category-btn").forEach(b => b.classList.toggle("open", b.dataset.cat === this._openCategory));
        sr.querySelectorAll(".cat-detail").forEach(d => d.classList.toggle("open", d.dataset.catDetail === this._openCategory));
      });
    });

    // Delete buttons
    sr.querySelectorAll(".item-delete").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const action = btn.dataset.action;
        if (action === "remove_denied") {
          this._callService("remove_denied_domain", { domain: btn.dataset.domain });
        } else if (action === "remove_allowed") {
          this._callService("remove_allowed_domain", { domain: btn.dataset.domain });
        } else if (action === "remove_dns") {
          this._callService("remove_dns_record", { ip: btn.dataset.ip, domain: btn.dataset.domain });
        } else if (action === "remove_cname") {
          this._callService("remove_dns_cname", { domain: btn.dataset.domain, target: btn.dataset.target });
        } else if (action === "remove_bl") {
          this._callService("remove_blocklist", { url: btn.dataset.url });
        }
      });
    });

    // Blocklist toggles
    sr.querySelectorAll(".bl-toggle").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const id = parseInt(btn.dataset.id);
        const wasEnabled = btn.dataset.enabled === "true";
        this._callService("toggle_blocklist", { list_id: id, enabled: !wasEnabled });
      });
    });

    // Add denied domain
    const addDeniedBtn = sr.getElementById("addDeniedBtn");
    const addDeniedInput = sr.getElementById("addDeniedInput");
    const addDeniedSub = sr.getElementById("addDeniedSubdomains");
    if (addDeniedBtn && addDeniedInput) {
      const doAdd = () => {
        const val = addDeniedInput.value.trim();
        if (!val) return;
        const inclSub = addDeniedSub ? addDeniedSub.checked : true;
        this._callService("add_denied_domain", { domain: val, comment: "via Dashboard", include_subdomains: inclSub });
        addDeniedInput.value = "";
      };
      addDeniedBtn.addEventListener("click", doAdd);
      addDeniedInput.addEventListener("keydown", (e) => { if (e.key === "Enter") doAdd(); });
    }

    // Add allowed domain
    const addAllowedBtn = sr.getElementById("addAllowedBtn");
    const addAllowedInput = sr.getElementById("addAllowedInput");
    const addAllowedSub = sr.getElementById("addAllowedSubdomains");
    if (addAllowedBtn && addAllowedInput) {
      const doAdd = () => {
        const val = addAllowedInput.value.trim();
        if (!val) return;
        const inclSub = addAllowedSub ? addAllowedSub.checked : true;
        this._callService("add_allowed_domain", { domain: val, comment: "via Dashboard", include_subdomains: inclSub });
        addAllowedInput.value = "";
      };
      addAllowedBtn.addEventListener("click", doAdd);
      addAllowedInput.addEventListener("keydown", (e) => { if (e.key === "Enter") doAdd(); });
    }

    // Add DNS record
    const addDnsBtn = sr.getElementById("addDnsBtn");
    const addDnsIp = sr.getElementById("addDnsIpInput");
    const addDnsDomain = sr.getElementById("addDnsDomainInput");
    if (addDnsBtn && addDnsIp && addDnsDomain) {
      const doAdd = () => {
        const ip = addDnsIp.value.trim();
        const domain = addDnsDomain.value.trim();
        if (!ip || !domain) return;
        this._callService("add_dns_record", { ip, domain });
        addDnsIp.value = "";
        addDnsDomain.value = "";
      };
      addDnsBtn.addEventListener("click", doAdd);
      addDnsDomain.addEventListener("keydown", (e) => { if (e.key === "Enter") doAdd(); });
    }

    // Add CNAME record
    const addCnameBtn = sr.getElementById("addCnameBtn");
    const addCnameDomain = sr.getElementById("addCnameDomainInput");
    const addCnameTarget = sr.getElementById("addCnameTargetInput");
    if (addCnameBtn && addCnameDomain && addCnameTarget) {
      const doAdd = () => {
        const domain = addCnameDomain.value.trim();
        const target = addCnameTarget.value.trim();
        if (!domain || !target) return;
        this._callService("add_dns_cname", { domain, target });
        addCnameDomain.value = "";
        addCnameTarget.value = "";
      };
      addCnameBtn.addEventListener("click", doAdd);
      addCnameTarget.addEventListener("keydown", (e) => { if (e.key === "Enter") doAdd(); });
    }

    // DNS Compare
    sr.getElementById("dnsCompareBtn")?.addEventListener("click", async () => {
      this._dnsCompareLoading = true;
      this._updateDnsCompare();
      try {
        this._dnsCompareData = await this._callServiceWithResponse("compare_dns_records", {});
      } catch (err) {
        this._showFeedback("error", "Compare Fehler: " + err.message);
      }
      this._dnsCompareLoading = false;
      this._updateDnsCompare();
    });

    // Add blocklist
    const addBlBtn = sr.getElementById("addBlBtn");
    const addBlInput = sr.getElementById("addBlInput");
    if (addBlBtn && addBlInput) {
      const doAdd = () => {
        const val = addBlInput.value.trim();
        if (!val) return;
        this._callService("add_blocklist", { url: val, comment: "via Dashboard" });
        addBlInput.value = "";
      };
      addBlBtn.addEventListener("click", doAdd);
      addBlInput.addEventListener("keydown", (e) => { if (e.key === "Enter") doAdd(); });
    }

    this._bindTopBlockedBtn();
    this._bindRecentQueriesBtn();

    // Sync all
    sr.getElementById("syncAllBtn")?.addEventListener("click", () => {
      this._callService("sync_all", {});
    });
  }

  static getStubConfig() {
    return {};
  }
}

customElements.define("pihole-manager-card", PiholeManagerCard);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "pihole-manager-card",
  name: "Pi-hole Manager",
  description: "Unified Pi-hole dashboard with admin controls",
  preview: false,
});
