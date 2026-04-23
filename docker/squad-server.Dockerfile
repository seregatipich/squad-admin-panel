FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      libc6 \
      libstdc++6 \
      libgcc-s1 \
      libssl3 \
      ca-certificates \
      tini \
      util-linux \
      procps \
 && rm -rf /var/lib/apt/lists/*

RUN groupadd --gid 1001 squad \
 && useradd --uid 1001 --gid 1001 --home-dir /squad --shell /usr/sbin/nologin squad \
 && mkdir -p /squad \
 && chown squad:squad /squad

COPY squad-server-entrypoint.sh /usr/local/bin/squad-server-entrypoint.sh
RUN chmod +x /usr/local/bin/squad-server-entrypoint.sh

WORKDIR /squad
ENV LD_LIBRARY_PATH=/squad/SquadGame/Binaries/Linux:/squad/Engine/Binaries/Linux:/squad/Engine/Binaries/ThirdParty/Steamworks/Steamv157/x86_64-unknown-linux-gnu

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/squad-server-entrypoint.sh"]
CMD ["RANDOM=ALWAYS", "-log"]
