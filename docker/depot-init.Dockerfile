FROM debian:bookworm-slim

LABEL panel.preserve=true panel.kind=depot-init

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8

RUN dpkg --add-architecture i386 \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      lib32gcc-s1 \
      lib32stdc++6 \
      libc6:i386 \
      libcurl4-gnutls-dev:i386 \
      tini \
      util-linux \
 && rm -rf /var/lib/apt/lists/*

RUN groupadd --gid 1001 steam \
 && useradd --uid 1001 --gid 1001 --home-dir /home/steam --create-home --shell /bin/bash steam

RUN mkdir -p /home/steam/steamcmd \
 && cd /home/steam/steamcmd \
 && curl -fsSL https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz | tar -xz \
 && chown -R 1001:1001 /home/steam

COPY depot-init-entrypoint.sh /usr/local/bin/depot-init-entrypoint.sh
RUN chmod +x /usr/local/bin/depot-init-entrypoint.sh

ENV PATH=/home/steam/steamcmd:$PATH

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/depot-init-entrypoint.sh"]
CMD ["+@sSteamCmdForcePlatformType", "linux", \
     "+force_install_dir", "/depot", \
     "+login", "anonymous", \
     "+app_update", "403240", "validate", \
     "+quit"]
