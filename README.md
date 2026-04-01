# Pi-hole Manager

Custom Home Assistant integration for **centralized management of multiple Pi-hole v6 instances** — including a built-in Lovelace dashboard card.

<!-- screenshot -->

---

## Features

- Multi-instance management from a single place
- Unified dashboard card (auto-registered, no manual resource setup)
- Aggregated stats across all Pi-holes
- Master blocking toggle (all instances at once)
- Denied / Allowed domain management (with subdomain blocking)
- Local DNS records (A + CNAME)
- Blocklist (adlist) management
- Cross-instance sync
- Top blocked domains & recent queries (on-demand)
- Pi-hole v6 API (not v5)

---

## Installation

### HACS (Custom repository)

1. HACS → **Integrations**
2. Menu (...) → **Custom repositories**
3. Add repository URL: `https://github.com/TomTuTHub/ha-pihole-manager`
4. Category: **Integration**
5. Install → **Restart Home Assistant**

### Manual

1. Copy `custom_components/pihole_manager` to:
   - `<config>/custom_components/pihole_manager`
2. Restart Home Assistant

---

## Configuration

1. Settings → **Devices & Services**
2. **Add Integration**
3. Search for **Pi-hole Manager**
4. Enter host, port, and admin password
5. Repeat for each Pi-hole instance

The Lovelace card is registered automatically. Add it to any dashboard:

```yaml
type: custom:pihole-manager-card
```

---

## What this is NOT

This integration does **not** replace the official Pi-hole integration. It focuses on **management** (blocklists, domains, DNS, sync), not monitoring. Both can run side by side.

---

## Support / Issues

Please open a **GitHub Issue** and include:

- Home Assistant version
- Integration version
- Pi-hole version
- Relevant logs (**Settings → System → Logs**, filter for `pihole_manager`)
- Steps to reproduce

---

## License

MIT

---

## Transparency

I'm a trained IT systems specialist with many years of experience in the field. Back in the day it was MCSE — today it's Vibe-Coding. What can I say: I built this integration with the help of **Claude** (Anthropic). The code has been reviewed and tested by me and runs in my own production setup.

---

Das war TomTuT, bleib hart am Gas.
