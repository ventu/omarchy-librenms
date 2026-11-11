# LibreNMS for Omarchy
<img width="483" height="716" alt="preview" src="https://github.com/user-attachments/assets/c7288f63-a666-4d6b-b697-4d4c3789ff6c" />
<p></p>
A bar plugin for monitoring devices in LibreNMS. After you save the server address and an API token, it checks once a minute and displays a small warning if a device is down.

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
