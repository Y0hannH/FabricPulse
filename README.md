# ⚡ FabricPulse

> Real-time pulse of your Microsoft Fabric pipelines — right inside VS Code.

![VS Code](https://img.shields.io/badge/VS%20Code-%5E1.85-007ACC?style=flat-square&logo=visualstudiocode)
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
| ⭐ | **Favoris** | Marquez les pipelines clés. Vue "Favoris seulement" pour ne surveiller que l'essentiel |
| 📊 | **Historique** | Graphe de durée, taux de succès, tableau des runs — stocké localement en SQLite |
| 🔔 | **Alertes** | Notification VS Code native sur échec ou dépassement de seuil. Rapport quotidien à 18h |
| ⚡ | **Quick Actions** | Re-run, Copy Run ID, Open in Fabric, View History — depuis le tableau |
| 🧠 | **Pattern Detection** | Détecte si un pipeline échoue souvent le même jour ou la même plage horaire |
| 🏢 | **Multi-tenant** | Gérez plusieurs tenants Azure / clients depuis un seul panneau |
| 📤 | **Export** | Export CSV ou JSON de l'historique pour vos rapports clients |
| 📝 | **Annotations** | Notes manuelles sur des dates pour corréler perfs et déploiements |

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
| Storage | SQLite (`better-sqlite3`) via `globalStorageUri` |
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

## Local Data & Privacy

FabricPulse ne collecte aucune donnée. Tout est stocké localement :

- **Historique des runs** : SQLite dans le dossier `globalStorage` de VS Code
- **Favoris et config** : VS Code `globalState`
- Aucune télémétrie, aucun backend, aucun appel externe hors API Fabric

Rétention par défaut : **90 jours**. Configurable dans les settings.

---

## Roadmap

- **v1.0** — Dashboard, favoris, historique, alertes, multi-tenant
- **v1.1** — Comparaison de runs, diff de paramètres entre deux exécutions  
- **v1.2** — Support Fabric Notebooks et Spark Jobs
- **v2.0** — Export partageable (rapport HTML statique pour client)

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
