# TomTuT Pi-hole Manager

Custom Lovelace card for Home Assistant that provides a **unified dashboard** to manage multiple Pi-hole v6 instances from a single place.

<!-- screenshot -->

---

## Features

- Unified view across all Pi-hole instances (aggregated stats)
- Expandable per-instance details
- Master blocking toggle (all instances at once)
- Admin section for managing:
  - Denied domains (blacklist)
  - Allowed domains (whitelist)
  - Local DNS records (A + CNAME)
  - Blocklists (adlists)
- Cross-instance sync (push changes to all Pi-holes)
- Top blocked domains & recent queries
- Auto-discovery of Pi-hole entities (no manual entity config needed)
- German & English translations

---

## Requirements

This card requires the **Pi-hole Manager** custom integration to be installed.
The integration provides the entities and services that the card uses.

Repository: [TomTuTHub/ha-pihole-manager](https://github.com/TomTuTHub/ha-pihole-manager) (Integration)

---

## Installation

### HACS (Custom repository)

1. HACS → **Frontend**
2. Menu (...) → **Custom repositories**
3. Add repository URL: `https://github.com/TomTuTHub/tomtut-pihole-manager`
4. Category: **Dashboard**
5. Install → **Restart Home Assistant**

### Manual

1. Download `pihole-manager-card.js` from the [latest release](https://github.com/TomTuTHub/tomtut-pihole-manager/releases)
2. Copy to `<config>/www/pihole-manager-card.js`
3. Add as resource in Lovelace:
   - Settings → Dashboards → Resources
   - URL: `/local/pihole-manager-card.js`
   - Type: JavaScript Module

---

## Configuration

Add the card to your Lovelace dashboard:

```yaml
type: custom:pihole-manager-card
```

No additional configuration needed — the card auto-discovers all Pi-hole Manager entities.

---

## Support / Issues

Please open a **GitHub Issue** and include:

- Home Assistant version
- Card version
- Browser (Chrome, Firefox, Safari, ...)
- Relevant browser console errors
- Steps to reproduce

---

## License

MIT

---

## Transparency

I'm a trained IT systems specialist with many years of experience in the field. Back in the day it was MCSE — today it's Vibe-Coding. What can I say: I built this card with the help of **Claude** (Anthropic). The code has been reviewed and tested by me and runs in my own production setup.

---

Das war TomTuT, bleib hart am Gas.
