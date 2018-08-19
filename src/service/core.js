'use strict';

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;


/**
 * Packet
 *
 * The packet class is a simple Object-derived class. It only exists to offer
 * conveniences for coercing to a string writable to a channel and constructing
 * from Strings and Objects. In future, it could probably be optimized to avoid
 * excessive shape-trees since it's the most common object in the protocol.
 */
var Packet = class Packet {

    constructor(data=null) {
        this.id = 0;
        this.type = undefined;
        this.body = {};

        if (data === null) {
            return;
        } else if (typeof data === 'string') {
            this.fromString(data);
        } else {
            this.fromObject(data);
        }
    }

    /**
     * Update the packet from a string of JSON
     *
     * @param {string} data - A string of text
     */
    fromString(data) {
        try {
            let json = JSON.parse(data);
            Object.assign(this, json);
        } catch (e) {
            throw Error(`Malformed packet: ${e.message}`);
        }
    }

    /**
     * Update the packet from an Object, using and intermediate call to
     * JSON.stringify() to deep-copy the object, avoiding reference entanglement
     *
     * @param {string} data - An object
     */
    fromObject(data) {
        try {
            let json = JSON.parse(JSON.stringify(data));
            Object.assign(this, json);
        } catch (e) {
            throw Error(`Malformed packet: ${e.message}`);
        }
    }

    [Symbol.toPrimitive](hint) {
        this.id = Date.now();

        switch (hint) {
            case 'string':
                return `${JSON.stringify(this)}\n`;
            case 'number':
                return `${JSON.stringify(this)}\n`.length;
            default:
                return true;
        }
    }

    toString() {
        return `${this}`;
    }
};


/**
 * Data Channel
 */
var Channel = GObject.registerClass({
    GTypeName: 'GSConnectCoreChannel',
    Signals: {
        'connected': {
            flags: GObject.SignalFlags.RUN_FIRST
        },
        'disconnected': {
            flags: GObject.SignalFlags.RUN_FIRST
        }
    },
    Properties: {
        'certificate': GObject.ParamSpec.object(
            'certificate',
            'TlsCertificate',
            'The TLS Certificate for this connection',
            GObject.ParamFlags.READABLE,
            Gio.TlsCertificate
        ),
        'type': GObject.ParamSpec.string(
            'type',
            'Data Channel Type',
            'The protocol this data channel uses',
            GObject.ParamFlags.READABLE,
            null
        )
    }
}, class Channel extends GObject.Object {

    _init(deviceId, type) {
        super._init();

        // We need this to lookup the certificate in GSettings
        this.identity = { body: { deviceId: deviceId } };
        this.service = Gio.Application.get_default();
        this._type = type;
    }

    get certificate() {
        if (this.type === 'tcp') {
            return this._connection.get_peer_certificate();
        }

        return null;
    }

    get type() {
        return this._type;
    }

    /**
     * Set socket options
     */
    async _initSocket(connection) {
        if (connection instanceof Gio.TcpConnection) {
            connection.socket.set_keepalive(true);
            connection.socket.set_option(6, 4, 10); // TCP_KEEPIDLE
            connection.socket.set_option(6, 5, 5);  // TCP_KEEPINTVL
            connection.socket.set_option(6, 6, 3);  // TCP_KEEPCNT
        }

        return connection;
    }

    /**
     * Read the identity packet from the new connection
     *
     * @param {Gio.SocketConnection} connection - An unencrypted socket
     */
    _receiveIdent(connection) {
        return new Promise((resolve, reject) => {
            let stream = new Gio.DataInputStream({
                base_stream: connection.input_stream,
                close_base_stream: false
            });

            stream.read_line_async(GLib.PRIORITY_DEFAULT, null, (stream, res) => {
                try {
                    let data = stream.read_line_finish(res)[0];
                    stream.close(null);

                    // Store the identity as an object property
                    this.identity = new Packet(data.toString());

                    resolve(connection);
                } catch (e) {
                    reject(e);
                }
            });
        });
    }

    /**
     * Write our identity packet to the new connection
     *
     * @param {Gio.SocketConnection} connection - An unencrypted socket
     */
    _sendIdent(connection) {
        return new Promise((resolve, reject) => {
            connection.output_stream.write_all_async(
                `${this.service.identity}`,
                GLib.PRIORITY_DEFAULT,
                null,
                (stream, res) => {
                    try {
                        stream.write_all_finish(res);
                        resolve(connection);
                    } catch (e) {
                        reject(e);
                    }
                }
            );
        });
    }

    /**
     * Verify connection certificate
     */
    _onAcceptCertificate(connection, peer_cert, flags) {
        log(`Authenticating ${this.identity.body.deviceId}`);

        connection.disconnect(connection._acceptCertificateId);

        // Bail if the deviceId is missing
        if (this.identity.body.deviceId === undefined) {
            logWarning('missing deviceId', connection.get_remote_address().to_string());
            return false;
        }

        // Get (or create) the settings for this deviceId
        let settings = new Gio.Settings({
            settings_schema: gsconnect.gschema.lookup(gsconnect.app_id + '.Device', true),
            path: gsconnect.settings.path + 'device/' + this.identity.body.deviceId + '/'
        });
        let cert_pem = settings.get_string('certificate-pem');

        // Verify the connection certificate if we have one
        if (cert_pem !== '') {
            return Gio.TlsCertificate.new_from_pem(cert_pem, -1).is_same(peer_cert);
        }

        // Otherwise trust on first use
        return true;
    }

    /**
     * Handshake Gio.TlsConnection
     */
    _handshake(connection) {
        return new Promise((resolve, reject) => {
            connection.validation_flags = 0;
            connection.authentication_mode = 1;
            connection._acceptCertificateId = connection.connect(
                'accept-certificate',
                this._onAcceptCertificate.bind(this)
            );

            connection.handshake_async(
                GLib.PRIORITY_DEFAULT,
                null,
                (connection, res) => {
                    try {
                        connection.handshake_finish(res);
                        resolve(connection);
                    } catch (e) {
                        reject(e);
                    }
                }
            );
        });
    }

    /**
     * If @connection is a Gio.TcpConnection, wrap it in Gio.TlsClientConnection
     * and initiate handshake, otherwise just return it.
     */
    async _clientEncryption(connection) {
        if (connection instanceof Gio.TcpConnection) {
            connection = Gio.TlsClientConnection.new(
                connection,
                connection.socket.remote_address
            );
            connection.set_certificate(this.service.certificate);

            return this._handshake(connection);
        } else {
            return connection;
        }
    }

    /**
     * If @connection is a Gio.TcpConnection, wrap it in Gio.TlsServerConnection
     * and initiate handshake, otherwise just return it.
     */
    async _serverEncryption(connection) {
        if (connection instanceof Gio.TcpConnection) {
            connection = Gio.TlsServerConnection.new(
                connection,
                this.service.certificate
            );

            return this._handshake(connection);
        } else {
            return connection;
        }
    }

    /**
     * Attach the channel to a device and monitor the input stream for packets
     *
     * @param {Device.Device} - The device to attach to
     */
    attach(device) {
        // Disconnect any existing channel
        if (device._channel !== null && device._channel !== this) {
            GObject.signal_handlers_destroy(device._channel);
            device._channel.close();
            device._channel = null;
        }

        device._channel = this;

        // Parse the channel's identity packet and connect signals to the device
        device._handleIdentity(this.identity);
        this.connect('connected', device._onConnected.bind(device));
        this.connect('disconnected', device._onDisconnected.bind(device));

        // Setup pollable streams for packet exchange
        this.input_stream = new Gio.DataInputStream({
            base_stream: this._connection.input_stream
        });

        this.output_stream = new Gio.DataOutputStream({
            base_stream: this._connection.output_stream
        });

        // Attach a source to the input channel, bound to the device
        this._monitor = this._connection.input_stream.create_source(null);
        this._monitor.set_callback(this.receive.bind(this, device));
        this._monitor.attach(null);

        // TODO: Plugins should be reloaded if we're swapping channel types.
        //       This is flakey in general, which may be Android's fault or
        //       possibly inherent in the protocol.

        // Emit connected:: if necessary
        if (!device.connected) {
            this.emit('connected');
        }
    }

    /**
     * Open an outgoing connection
     *
     * Outgoing connections are opened in response to a received (or cached) UDP
     * packet, with a mandatory kdeconnect.identity packet being sent when the
     * connection is accepted.
     *
     * @param {Gio.InetSocketAddress} address - The address to open a connection
     * @return {Boolean} - %true on connected, %false otherwise
     */
    async open(address) {
        log(`GSConnect: Opening connection to ${address.to_string()}`);

        try {
            this._connection = await new Promise((resolve, reject) => {
                let client = new Gio.SocketClient();

                client.connect_async(address, null, (client, res) => {
                    try {
                        resolve(client.connect_finish(res));
                    } catch (e) {
                        reject(e);
                    }
                });
            });
            this._connection = await this._initSocket(this._connection);
            this._connection = await this._sendIdent(this._connection);
            this._connection = await this._serverEncryption(this._connection);

            return true;
        } catch (e) {
            log(`GSConnect: ${e.message}`);
            debug(e);
            this.close();
            return false;
        }
    }

    /**
     * Accept an incoming connection
     *
     * Incoming connections are opened in response to a sent (or cached) UDP
     * packet, with a mandatory kdeconnect.identity packet being sent when the
     * connection is accepted.
     *
     * @param {Gio.TcpConnection} connection - The incoming connection
     * @return {Boolean} - %true on connected, %false otherwise
     */
    async accept(connection) {
        if (this.type === 'tcp') {
            let addr = connection.get_remote_address().to_string();
            log(`GSConnect: Accepting connection from ${addr}`);
        } else {
            log(`GSConnect: Accepting connection from Bluez`);
        }

        try {
            this._connection = await this._initSocket(connection);
            this._connection = await this._receiveIdent(this._connection);
            this._connection = await this._clientEncryption(this._connection);

            return true;
        } catch(e) {
            log(`GSConnect: ${e.message}`);
            debug(e);
            this.close();
            return false;
        }
    }

    /**
     * Close all streams associated with this channel, silencing any errors, and
     * emit 'disconnected::'
     */
    close() {
        if (this._monitor) {
            try {
                this._monitor.destroy();
            } catch (e) {
                debug(e.message);
            }
        }

        [this._connection, this.input_stream, this.output_stream].map(stream => {
            try {
                stream.close(null);
            } catch (e) {
                debug(e.message);
            }
        });

        if (this._listener) {
            try {
                this._listener.close();
            } catch (e) {
                debug(e.message);
            }
        }

        this.emit('disconnected');
    }

    /**
     * Send a packet to a device.
     *
     * TODO: Currently, we don't consider failed writes to consititute a broken
     * connection and just log a warning. This should be investigated and tested
     * over a period of time.
     *
     * @param {object} packet - An object containing the packet data
     */
    send(packet) {
        try {
            packet = new Packet(packet);
            this.output_stream.put_string(packet.toString(), null);
            debug(packet, this.identity.body.deviceName);
        } catch (e) {
            logWarning(e, this.identity.body.deviceName);
        }
    }

    /**
     * Receive a packet from the channel and call receivePacket() on the device
     */
    receive(device) {
        try {
            let data = this.input_stream.read_line(null)[0];
            let packet = new Packet(data.toString());

            debug(packet, device.name);

            device.receivePacket(packet);

            return GLib.SOURCE_CONTINUE;
        } catch (e) {
            debug(e, this.identity.body.deviceName);
            this.close();
            return GLib.SOURCE_REMOVE;
        }
    }
});


/**
 * File Transfers
 *
 * NOTE: transfers are always closed on completion
 *
 * Example Contruction:
 *  let transfer = new Protocol.Transfer({
 *      device: {Device.Device},
 *      size: {Number} size in bytes,
 *      input_stream: {Gio.InputStream} readable stream for uploads,
 *      output_stream: {Gio.OutputStream} writable stream for downloads
 *  });
 */
var Transfer = GObject.registerClass({
    GTypeName: 'GSConnectCoreTransfer',
    Signals: {
        'progress': {
            flags: GObject.SignalFlags.RUN_FIRST,
            param_types: [ GObject.TYPE_INT ]
        }
    },
    Properties: {
        'device': GObject.ParamSpec.object(
            'device',
            'TransferDevice',
            'The device associated with this transfer',
            GObject.ParamFlags.READWRITE | GObject.ParamFlags.CONSTRUCT_ONLY,
            GObject.Object
        ),
        'size': GObject.ParamSpec.uint(
            'size',
            'TransferSize',
            'The size in bytes of the transfer',
            GObject.ParamFlags.READWRITE | GObject.ParamFlags.CONSTRUCT_ONLY,
            0, GLib.MAXUINT32,
            0
        ),
        'uuid': GObject.ParamSpec.string(
            'uuid',
            'TransferUUID',
            'The UUID of this transfer',
            GObject.ParamFlags.READABLE,
            ''
        )
    }
}, class Transfer extends Channel {

    _init(params) {
        super._init(params.device.id, 'transfer');

        this._cancellable = new Gio.Cancellable();

        this._device = params.device;
        this.input_stream = params.input_stream;
        this.output_stream = params.output_stream;
        this._size = params.size;

        this.checksum = params.checksum;
        this._checksum = new GLib.Checksum(GLib.ChecksumType.MD5);
        this._written = 0;
        this._progress = 0;

        this.device._transfers.set(this.uuid, this);
    }

    get device() {
        return this._device;
    }

    get size() {
        return this._size || 0;
    }

    get uuid() {
        if (this._uuid === undefined) {
            this._uuid = GLib.uuid_string_random();
        }

        return this._uuid;
    }

    /**
     * Override in protocol implementation
     */
    async upload() {
        throw new GObject.NotImplementedError();
    }

    /**
     * Override in protocol implementation
     */
    async download() {
        throw new GObject.NotImplementedError();
    }

    /**
     * Cancel the transfer in progress
     */
    cancel() {
        this._cancellable.cancel();
    }

    close() {
        super.close();
        this.device._transfers.delete(this.uuid);
    }

    /**
     * Emit the progress signal with an integer between 0-100
     * @param {Number} increment - The increment to emit progress signals at
     */
    progress(increment=1) {
        let progress = Math.floor(this._written / this.size * 100);

        if (progress - this._progress >= increment) {
            this.emit('progress', progress);
        }

        this._progress = progress;
    }

    /**
     * For transfers without a checksum (currently all but notification icons)
     * we use g_output_stream_splice() which basically loops our read/writes
     * in 8192 byte chunks.
     *
     * @return {Boolean} - %true on success, %false on failure.
     */
    async _transfer() {
        let result;

        try {
            result = await new Promise((resolve, reject) => {
                this.output_stream.splice_async(
                    this.input_stream,
                    Gio.OutputStreamSpliceFlags.NONE,
                    GLib.PRIORITY_DEFAULT,
                    this._cancellable,
                    (source, res) => {
                        try {
                            if (source.splice_finish(res) < this.size) {
                                throw new Error('incomplete data');
                            }

                            resolve(true);
                        } catch (e) {
                            reject(e);
                        }
                    }
                );
            });
        } catch (e) {
            logError(e, this.device.name);
            result = false;
        } finally {
            this.close();
            return result;
        }
    }
});
