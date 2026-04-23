# §0A.1 — SteamCMD install (Squad dedicated server app 403240)

**Date:** 2026-04-23
**Host:** Ubuntu 24.04.4 LTS, 10 cores, 11 GiB RAM, 226 GB free on /
**SteamCMD version:** 1773426366 (Steam Console Client, Valve)

## Install timing

| Stage | Start | End | Duration |
|---|---|---|---|
| `apt-get install steamcmd` (+ i386 + multiverse) | 2026-04-23T11:17:15Z | 2026-04-23T11:17:45Z | ~30 s |
| `app_info_update 1; app_info_print 403240` (metadata) | 2026-04-23T11:18:47Z | 2026-04-23T11:18:52Z | ~5 s |
| `app_update 403240 validate` (download + verify) | 2026-04-23T11:19:40Z | 2026-04-23T11:22:06Z | **~2 min 26 s** (0xFinal state: Success) |

Download rate averaged ~85 MB/s against the Steam CDN edge available from this host. The `validate` phase reported no mismatches after the download.

## Download size — key finding vs TZ

The TZ §1.E.1 estimated the Squad depot at **~95 GB**. Actual numbers from Steam's own metadata for app 403240, branch `public`, linux oslist:

```
"gid"      "2508294661980328343"
"size"     "12694674173"   // 11.82 GiB on-disk after validate
"download" "12084856256"   // 11.26 GiB over the wire
```

Measured disk usage after validate:

```
$ du -sh /home/squad/squad-experiment/server/
12G     /home/squad/squad-experiment/server/
```

**→ Correction to TZ §1.E.1 / §1C/UC-01 / §17.6**: the Squad linux depot is ~12 GB, not ~95 GB. Install on a 200 Mbps link completes in ~8 minutes, not 45. This reduces §17.7 install-time expectations dramatically.

## `+@sSteamCmdForcePlatformType linux` is mandatory

First attempt without the platform flag:

```
ERROR! Failed to install app '403240' (Missing configuration)
```

With `+@sSteamCmdForcePlatformType linux` set **before** `+login anonymous`, the install succeeds. The TZ §2.1 does list this flag in the bridge whitelist — the ordering is what matters.

Working invocation:

```bash
steamcmd \
  +@sSteamCmdForcePlatformType linux \
  +@ShutdownOnFailedCommand 1 \
  +@NoPromptForPassword 1 \
  +force_install_dir /home/squad/squad-experiment/server \
  +login anonymous \
  +app_update 403240 validate \
  +quit
```

## Directory structure after install (before any boot)

```
squad-experiment/server/
├── Engine/                       # UE5 engine
├── linux64/
│   ├── libsteamwebrtc.so
│   └── steamclient.so
├── Manifest_*_Linux.txt          # 3 manifest files
├── SquadGame/
│   ├── Binaries/Linux/
│   │   ├── SquadGameServer       # 268 MB main binary
│   │   ├── libEOSSDK-Linux-Shipping.so
│   │   ├── libboost_*.so         # boost 1.82.0
│   │   ├── steamclient.so
│   │   ├── steam_appid.txt       # "403240"
│   │   └── libsteamwebrtc.so
│   ├── Content/
│   ├── Plugins/
│   └── ServerConfig/             # ← already populated, see below
├── SquadGameServer.sh            # launcher
├── installscript.vdf
├── libsteamwebrtc.so
├── steamapps/
│   └── appmanifest_403240.acf
└── steamclient.so
```

## **Critical finding — configs ship with the depot**

TZ §17.6 states:

> Squad create `SquadGame/ServerConfig/*.cfg` **только при первом запуске сервера**, не сразу после SteamCMD install.

**This is incorrect.** Immediately after `app_update 403240 validate`, the `SquadGame/ServerConfig/` directory is fully populated with 19 `.cfg` files. No bootstrap boot is required.

Full inventory of default configs (byte size; contents dumped to `configs-default/`):

| File | Bytes | Purpose |
|---|---:|---|
| `Admins.cfg` | 2335 | Access-level definitions + local admins (template with comments only, no real admins) |
| `Bans.cfg` | 0 | Empty ban list |
| `CustomOptions.cfg` | 1678 | Mod-specific options, seeding thresholds |
| `ExcludedFactions.cfg` | 1870 | Faction ID exclusion list (template, all commented out) |
| `ExcludedLayers.cfg` | 1857 | Layer exclusion list (JensensRange_* pre-excluded) |
| `ExcludedLevels.cfg` | 790 | Level exclusion list (TutorialInfantry/Helicopter/JensensRange pre-excluded) |
| `LayerRotation.cfg` | 807 | Empty except comments |
| `LayerVoting.cfg` | 4658 | Default layer vote pool (AlBasrah + many others) |
| `LayerVotingLowPlayers.cfg` | 5014 | Template, all commented |
| `LayerVotingNight.cfg` | 4967 | Template, all commented |
| `LevelRotation.cfg` | 756 | AlBasrah, Anvil, Belaya, BlackCoast, Chora, ... |
| `License.cfg` | 0 | Empty (LicenseId/LicenseKey go here for licensed servers) |
| `MOTD.cfg` | 191 | Default MOTD |
| `Rcon.cfg` | 1952 | IP=0.0.0.0, Port=21114, **Password=** (empty → RCON disabled until set) |
| `RemoteAdminListHosts.cfg` | 0 | Empty |
| `RemoteBanListHosts.cfg` | 405 | Comments only |
| `Server.cfg` | 4149 | ServerName="Squad Dedicated Server", MaxPlayers=100, MapRotationMode=LayerList_Vote, etc. |
| `ServerMessages.cfg` | 120 | Default message |
| `VoteConfig.cfg` | 2800 | Vote durations, thresholds |

### Consequence for panel install flow

The install flow specified in TZ §17.6 can be **simplified**:

```
1.  apt_install(deps)
2.  steamcmd_run(+force_install_dir ... +app_update 403240 validate)
3.  # NO bootstrap boot needed — configs are already there
4.  file_atomic_write on SquadGame/ServerConfig/Rcon.cfg
       → set Password=<generated 32 chars>
5.  file_atomic_write on SquadGame/ServerConfig/Server.cfg
       → set ServerName="<user-provided>"
       → set MaxPlayers=<user-provided>
6.  systemctl_write_unit → squad-server-{uuid}.service
7.  systemctl_daemon_reload
8.  systemctl enable squad-server-{uuid}
9.  ufw_rule add for game/query/beacon ports
```

§0A.10 will apply this to TZ §17.6.

## Other notable files

- **`steam_appid.txt`** lives inside `SquadGame/Binaries/Linux/`, not in the root — the TZ snapshot showed it missing from root, which is expected.
- **`installscript.vdf`** is a Valve install script (unused by panel).
- **`libboost_*.so`** boost 1.82.0 libraries are shipped alongside the binary — Squad pins its own rather than relying on distro boost.

## Готовность к §0A.2

- [x] steamcmd установлен и работает (self-update успешен)
- [x] Squad dedicated server depot скачан (`12 GB`, exit 0)
- [x] Manifest validate passed
- [x] Все default configs задокументированы в `configs-default/`
- [x] Директория готова к первому запуску
- [x] 2 расхождения с TZ зафиксированы для §0A.10 corrections:
  1. Download size 12 GB, не 95 GB
  2. Configs ships with depot, не создаются на first boot
