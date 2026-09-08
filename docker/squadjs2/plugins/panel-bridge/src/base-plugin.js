/**
 * Local stand-in for SquadJS2's `squad-server/plugins/base-plugin.js`.
 *
 * The image never uses this file: `docker/squadjs2.Dockerfile` copies only
 * `panel-bridge.js` and the `panel-bridge/` directory, so `./base-plugin.js`
 * resolves to upstream's own class inside the container. It exists here so the
 * plugin can be unit-tested outside the image, and it mirrors upstream's
 * constructor semantics exactly — including `required` rejecting a value equal
 * to the declared default — so a divergence shows up in these tests first.
 */
export default class BasePlugin {
  constructor(server, options, connectors) {
    this.server = server;
    this.options = {};
    this.rawOptions = options;

    for (const [optionName, option] of Object.entries(this.constructor.optionsSpecification)) {
      if (option.connector) {
        const connectorName =
          typeof this.rawOptions[optionName] !== 'undefined'
            ? this.rawOptions[optionName]
            : option.default;
        this.options[optionName] = connectorName ? connectors[connectorName] : connectorName;
      } else {
        if (option.required) {
          if (!(optionName in this.rawOptions))
            throw new Error(`${this.constructor.name}: ${optionName} is required but missing.`);
          if (option.default === this.rawOptions[optionName])
            throw new Error(
              `${this.constructor.name}: ${optionName} is required but is the default value.`,
            );
        }

        this.options[optionName] =
          typeof this.rawOptions[optionName] !== 'undefined'
            ? this.rawOptions[optionName]
            : option.default;
      }
    }
  }

  async prepareToMount() {}

  async mount() {}

  async unmount() {}

  verbose() {}
}
