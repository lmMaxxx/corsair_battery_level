const HID = require('node-hid');
const SysTray = require('systray2').default;
const path = require('path');

const DATA_REQ = [0xC9, 0x64];
const CORSAIR_VID = 0x1B1C;

const KNOWN_PIDS = {
    0x0A38: "HS70 Wireless",
    0x0A4F: "HS70 PRO Wireless",
    0x1B27: "VOID Wireless",
    0x0A2B: "VOID Wireless",
    0x0A14: "VOID PRO Wireless",
    0x0A16: "VOID PRO Wireless",
    0x0A1A: "VOID PRO Wireless",
    0x0A55: "VOID ELITE Wireless",
    0x0A51: "VOID ELITE Wireless",
    0x0A3E: "Virtuoso RGB Wireless",
    0x0A40: "Virtuoso RGB Wireless",
    0x0A42: "Virtuoso RGB Wireless",
    0x0A44: "Virtuoso RGB Wireless",
    0x0A5C: "Virtuoso RGB Wireless",
    0x0A64: "Virtuoso RGB Wireless",

    // HS80 RGB Wireless (dein Setup: PID 0x0A6B)
    0x0A6B: "HS80 RGB Wireless",

    // Optional: weitere HS80-Revisionen, falls du das Tool mal verteilst
    // 0x0A6A: "HS80 RGB Wireless",
    // 0x0A73: "HS80 RGB Wireless",
};

const DEVICE_STATES = {
    0: "Disconnected",
    1: "Connected",
    2: "Low battery",
    4: "Fully charged",
    5: "Charging"
};

const TRAY_ICONS = {
    default: path.join(__dirname, "icons/headphones.ico"),
    charging: path.join(__dirname, "icons/battery-charging.ico"),
    10: path.join(__dirname, "icons/battery-wireless.ico"),
    9: path.join(__dirname, "icons/battery-wireless-90.ico"),
    8: path.join(__dirname, "icons/battery-wireless-80.ico"),
    7: path.join(__dirname, "icons/battery-wireless-70.ico"),
    6: path.join(__dirname, "icons/battery-wireless-60.ico"),
    5: path.join(__dirname, "icons/battery-wireless-50.ico"),
    4: path.join(__dirname, "icons/battery-wireless-40.ico"),
    3: path.join(__dirname, "icons/battery-wireless-30.ico"),
    2: path.join(__dirname, "icons/battery-wireless-20.ico"),
    1: path.join(__dirname, "icons/battery-wireless-10.ico"),
    0: path.join(__dirname, "icons/battery-wireless-0.ico"),
};

const MENU_ITEMS = [
    {
        title: "Refresh device",
        tooltip: "Refresh device",
        checked: false,
        enabled: true,
        click: init_device
    },
    {
        title: "Exit",
        tooltip: "Exit",
        checked: false,
        enabled: true,
        click: () => {
            tray.kill(false);
            process.exit(0);
        }
    }
];

const TRAY_OPTIONS = {
    menu: {
        icon: TRAY_ICONS["default"],
        title: "Corsair battery level",
        tooltip: "No device found",
        items: MENU_ITEMS
    },
    debug: false,
    copyDir: true
};

// Offset nur für bestimmte Void-Modelle (Mic-Up-Bit)
const VOID_BATTERY_MICUP = 128;
const VOID_MICUP_PIDS = new Set([
    0x1B27,
    0x0A2B,
    0x0A14,
    0x0A16,
    0x0A1A,
    0x0A55,
    0x0A51
]);

const tray = new SysTray(TRAY_OPTIONS);

let device_info = null;
let device_hid = null;

// Clean exit
process.on('exit', () => {
    tray.kill(false);
});

// Menü-Klicks
tray.onClick(event => {
    if (event && event.item && typeof event.item.click === 'function') {
        event.item.click();
    }
});

// Wenn Tray ready → Device suchen
tray.ready().then(init_device);

// Initialisiert das HID-Device
function init_device() {
    [device_hid, device_info] = get_HID();

    if (!device_hid || !device_info) {
        device_info = null;
        reset_tray();
        return;
    }

    const nameFromMap = KNOWN_PIDS[device_info.productId];
    const fallbackName = device_info.product || "Corsair Device";
    device_info.full_name = `${device_info.manufacturer || "Corsair"} ${nameFromMap || fallbackName}`;

    device_hid.setNonBlocking(1);

    device_hid.on('data', update_tray);
    device_hid.on('error', () => {
        device_info = null;
        device_hid = null;
        reset_tray();
    });

    device_hid.resume();
}

// Sucht das erste passende Corsair-Device mit bekannter PID,
// das auf unseren DATA_REQ reagiert
function get_HID() {
    const dList = HID.devices();
    let hidDevice = null;
    let infoObj = null;

    for (const deviceObj of dList) {
        if (deviceObj.vendorId !== CORSAIR_VID) continue;
        if (KNOWN_PIDS[deviceObj.productId] === undefined) continue;

        try {
            const testHid = new HID.HID(deviceObj.path);
            // Test, ob dieses Interface den Request akzeptiert
            testHid.write(DATA_REQ);
            testHid.pause();

            hidDevice = testHid;
            infoObj = deviceObj;
            break;
        } catch (e) {
            // Wenn dieses Interface nicht passt → nächstes probieren
            hidDevice = null;
            infoObj = null;
            continue;
        }
    }

    return [hidDevice, infoObj];
}

// Verarbeitet die vom Headset kommenden Daten
// Erwartet Buffer/Array: [?, ?, battery, ?, state]
function update_tray([, , rawBattery, , state]) {
    if (!device_info) {
        reset_tray();
        return;
    }

    let battery = rawBattery;

    // Nur für bestimmte Void-Modelle das Mic-Up-Bit entfernen
    if (VOID_MICUP_PIDS.has(device_info.productId) && battery > VOID_BATTERY_MICUP) {
        battery = battery - VOID_BATTERY_MICUP;
    }

    let icon;
    let tooltip;
    const stateLabel = DEVICE_STATES[state] || "Connected";

    if (state === 0 || DEVICE_STATES[state] === undefined) {
        // Disconnected / Unbekannter Status
        icon = TRAY_ICONS["default"];
        tooltip = `${device_info.full_name}: ${DEVICE_STATES[0]}`;
    } else if (state === 5) {
        // Charging
        icon = TRAY_ICONS["charging"];
        tooltip = `${device_info.full_name}: ${stateLabel}`;
    } else {
        // Normaler Betriebszustand mit Prozentanzeige
        // Batterie auf 0–100 clampen und passenden Icon-Slot wählen
        if (typeof battery !== 'number' || Number.isNaN(battery)) {
            battery = 0;
        }
        if (battery < 0) battery = 0;
        if (battery > 100) battery = 100;

        const level = Math.max(0, Math.min(10, Math.floor(battery / 10)));
        icon = TRAY_ICONS[level] || TRAY_ICONS["default"];
        tooltip = `${device_info.full_name}: ${stateLabel} (${battery}%)`;
    }

    tray.sendAction({
        type: 'update-menu',
        menu: {
            icon,
            tooltip,
            title: tooltip,
            items: MENU_ITEMS
        }
    });
}

// Setzt Tray zurück, wenn kein Device gefunden / Fehler
function reset_tray() {
    tray.sendAction({
        type: 'update-menu',
        menu: {
            icon: TRAY_ICONS["default"],
            title: "Corsair battery level",
            tooltip: "No device found",
            items: MENU_ITEMS
        }
    });
}
