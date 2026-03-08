# ⚡ FabricPulse

> Real-time pulse of your Microsoft Fabric pipelines — right inside VS Code.

![VS Code](https://img.shields.io/badge/VS%20Code-%5E1.85-007ACC?style=flat-square&logo=visualstudiocode)
![Version](https://img.shields.io/badge/Version-1.1.0-blue?style=flat-square)
![License](https://img.shields.io/badge/License-MIT-00B4D8?style=flat-square)
![Status](https://img.shields.io/badge/Status-In%20Development-orange?style=flat-square)

---

## What is FabricPulse?

FabricPulse is a VS Code extension for data engineers working with Microsoft Fabric. It brings pipeline monitoring directly into your development environment — no context switching, no slow portal, no waiting for Power BI to load.

You choose which pipelines matter. FabricPulse watches them, stores their history locally, and alerts you when something goes wrong.

---

## Features

| | Feature | Description |
|---|---|---|
| 📋 | **Dashboard** | Tableau de tous vos pipelines avec statut coloré, filtre live par workspace et nom |
| ⭐ | **Favoris** | Marquez les pipelines clés. Vue "Favoris seulement" — chargés en priorité au démarrage |
| 📊 | **Historique** | Graphe de durée, taux de succès, tableau des runs — stocké localement en SQLite |
| 🔔 | **Alertes** | Notification VS Code native sur échec ou dépassement de seuil. Rapport quotidien configurable |
| ⚡ | **Quick Actions** | Re-run, Copy Run ID, Open in Fabric, View History — depuis le tableau |
| 🧠 | **Pattern Detection** | Détecte si un pipeline échoue souvent le même jour ou la même plage horaire |
| 🏢 | **Multi-tenant** | Gérez plusieurs tenants Azure / clients depuis un seul panneau |
| 📤 | **Export** | Export CSV ou JSON de l'historique pour vos rapports clients |
| 📝 | **Annotations** | Notes manuelles sur des dates pour corréler perfs et déploiements |
| 🧮 | **Semantic Models** | Monitoring des Semantic Models Power BI/Fabric (refreshes, statuts) |
| 🔢 | **Total Executions** | Compteur total de runs affiché par pipeline pour qualifier la fréquence |
| 🚀 | **Smart Loading** | Chargement prioritaire des favoris, batch configurable, cache instantané au démarrage |
| 🚫 | **Workspace Blacklist** | Excluez des workspaces du polling (par ID ou nom) pour éviter le bruit |

---

## Getting Started

### Prerequisites

- VS Code 1.85+
- Azure CLI installé et configuré (`az login`)
- Accès à un workspace Microsoft Fabric

### Installation

```bash
# Depuis le marketplace (quand disponible)
ext install evolve.fabricpulse

# Depuis la source
git clone https://github.com/evolve/fabricpulse
cd fabricpulse
npm install
npm run compile
```

### First Run

1. Ouvrez la Command Palette (`Ctrl+Shift+P`)
2. Lancez `FabricPulse: Open Dashboard`
3. Ajoutez votre tenant via `FabricPulse: Add Tenant`
4. Marquez vos pipelines critiques comme favoris ⭐

---

## Architecture

| Layer | Stack |
|---|---|
| Extension Host | TypeScript + VS Code Extension API |
| UI / Webview | HTML/CSS/JS vanilla — thème VS Code natif |
| Auth | Azure CLI (`az login`) + fallback browser interactif |
| API | Microsoft Fabric REST API v1 |
| Storage | SQLite (`sql.js`) via `globalStorageUri` |
| Alerting | VS Code Notification API + polling toutes les 60s |

---

## Commands

| Command | Description |
|---|---|
| `fabricPulse.openDashboard` | Ouvre le dashboard principal |
| `fabricPulse.addTenant` | Ajoute un tenant Azure |
| `fabricPulse.exportHistory` | Export CSV de l'historique du pipeline sélectionné |
| `fabricPulse.clearHistory` | Purge l'historique local |

---

## Configuration

| Setting | Default | Description |
|---|---|---|
| `fabricPulse.pollingInterval` | `60` | Intervalle de refresh en secondes |
| `fabricPulse.retentionDays` | `90` | Jours de rétention de l'historique |
| `fabricPulse.dailyReportTime` | `"18:00"` | Heure du rapport quotidien (HH:MM) |
| `fabricPulse.batchSize` | `5` | Pipelines fetchés par batch |
| `fabricPulse.batchDelayMs` | `2500` | Délai entre batches (ms) pour éviter le rate limiting |
| `fabricPulse.batchThreshold` | `10` | Nombre min. de pipelines stale pour déclencher le batching |
| `fabricPulse.blacklistedWorkspaces` | `[]` | Workspaces exclus du polling (ID ou nom) |

---

## Local Data & Privacy

FabricPulse ne collecte aucune donnée. Tout est stocké localement :

- **Historique des runs** : SQLite dans le dossier `globalStorage` de VS Code
- **Favoris et config** : VS Code `globalState`
- Aucune télémétrie, aucun backend, aucun appel externe hors API Fabric

Rétention par défaut : **90 jours**. Configurable dans les settings.

---

## Roadmap

### ✅ v1.0 — Foundation
Dashboard, favoris, historique, alertes, multi-tenant, export CSV/JSON, pattern detection, annotations.

### ✅ v1.1 — Semantic Models & Performance
- Support Semantic Models (Power BI / Fabric refreshes)
- Chargement prioritaire des favoris au démarrage
- Batch configurable avec cache instantané
- Blacklist de workspaces
- Compteur de runs total par pipeline
- Fix timezone sur les timestamps de runs

### 🔲 v1.2 — Notebooks & Spark Jobs
- Support Fabric Notebooks (runs, durées, statuts)
- Support Spark Jobs
- Filtres unifiés pipelines + notebooks + semantic models

### 🔲 v1.3 — Run Analysis
- Comparaison de deux runs d'un même pipeline (paramètres, durées, logs)
- Diff de configuration entre exécutions

### 🔲 v2.0 — Sharing & Cross-tenant
- Export rapport HTML statique (pour partage client)
- Panel "Pinned Items" cross-tenant : surveiller favoris de plusieurs tenants dans une seule vue

---

## Contributing

Le projet est en développement actif. Les contributions seront ouvertes dès la publication du repo.

- Fork → branch → PR
- Ouvrez une issue pour discuter d'une feature avant de coder
- Respectez la convention de nommage existante

---

## License

MIT © 2025 [Evolve](https://evolve-data.fr) — Yohann

---

*Built with ♥ by Evolve*
