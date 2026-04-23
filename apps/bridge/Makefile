BIN := bin/panel-host-bridge

.PHONY: all build test lint vet vulncheck install clean

all: build

build:
	mkdir -p bin
	CGO_ENABLED=0 go build -trimpath -ldflags='-s -w -X main.Version=$(shell git describe --tags --always --dirty 2>/dev/null || echo dev)' -o $(BIN) ./cmd/panel-host-bridge

test:
	go test -race -count=1 ./...

lint:
	go vet ./...
	@gofmt -l -s . | { ! grep -v -e '^$$' ; }

vulncheck:
	govulncheck ./...

install: build
	install -m 0755 $(BIN) /usr/local/bin/panel-host-bridge
	install -m 0644 deploy/panel-host-bridge.service /etc/systemd/system/panel-host-bridge.service
	install -m 0644 deploy/panel-host-bridge.socket  /etc/systemd/system/panel-host-bridge.socket
	systemctl daemon-reload

clean:
	rm -rf bin
