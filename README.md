# LibreNMS for Omarchy

A bar plugin for devices LibreNMS marks down. After you save the server address and an API token, it checks once a minute and sends a notification when a device goes offline or comes back. The first check stays quiet, so devices that are already down do not each raise a notification.

The address and token are written to `secret.json` next to the plugin, mode 600. That file is not part of this repository.

## Install

```sh
omarchy plugin add https://github.com/ventu/omarchy-librenms.git --enable
```

The plugin id is `mvolz.librenms`. Without `--enable`, turn it on later:

```sh
omarchy plugin enable mvolz.librenms --section right
```

## Remove

```sh
omarchy plugin remove mvolz.librenms
```

Removing the plugin also removes the saved address and token.

## Dependencies

`curl` asks LibreNMS for the down list. `jq` checks the address and token before they are saved. Both ship with Omarchy.

## License

MIT
