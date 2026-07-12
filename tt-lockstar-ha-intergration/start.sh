#!/usr/bin/env bashio

export MQTT_HOST=$(bashio::services mqtt "host")
export MQTT_PORT=$(bashio::services mqtt "port")
export MQTT_SSL=$(bashio::services mqtt "ssl")
export MQTT_USER=$(bashio::services mqtt "username")
export MQTT_PASS=$(bashio::services mqtt "password")
if bashio::config.has_value "bluetooth_adapter"; then
  ADAPTER=$(bashio::config "bluetooth_adapter")
  if [[ $ADAPTER =~ hci([0-9]+) ]]; then
    export NOBLE_HCI_DEVICE_ID="${BASH_REMATCH[1]}"
  else
    export NOBLE_HCI_DEVICE_ID="$ADAPTER"
  fi
  bashio::log.info "Using Bluetooth adapter: hci${NOBLE_HCI_DEVICE_ID}"
else
  export NOBLE_HCI_DEVICE_ID="0"
  bashio::log.info "No BLE adapter configured, defaulting to hci0"
fi

if bashio::config.has_value "bluetooth_transport"; then
  export TTLOCK_BLUETOOTH_TRANSPORT=$(bashio::config "bluetooth_transport")
else
  export TTLOCK_BLUETOOTH_TRANSPORT="raw_hci"
fi

if [[ "${TTLOCK_BLUETOOTH_TRANSPORT}" == "dbus" ]]; then
  export NOBLE_BINDINGS="dbus"
  export NOBLE_DBUS_ADAPTER_ID="hci${NOBLE_HCI_DEVICE_ID}"
  bashio::log.warning "Using experimental @stoprocent/noble BlueZ D-Bus transport on ${NOBLE_DBUS_ADAPTER_ID}"
else
  unset NOBLE_BINDINGS
  unset NOBLE_DBUS_ADAPTER_ID
  bashio::log.warning "Using legacy raw-HCI transport on hci${NOBLE_HCI_DEVICE_ID}; this is the hardware-validated fallback"
fi

if $(bashio::config.true "ignore_crc"); then
  echo "IGNORE CRC TRUE"
  export TTLOCK_IGNORE_CRC=1
fi
if $(bashio::config.true "debug_communication"); then
  echo "Debug communication ON"
  export TTLOCK_DEBUG_COMM=1
fi
if $(bashio::config.true "debug_mqtt"); then
  echo "Debug MQTT"
  export MQTT_DEBUG=1
fi

cd /app
npm start
