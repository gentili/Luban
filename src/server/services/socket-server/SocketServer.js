import rangeCheck from 'range_check';
import serialport from 'serialport';
import SocketIO from 'socket.io';
import socketioJwt from 'socketio-jwt';
import ensureArray from '../../lib/ensure-array';
import logger from '../../lib/logger';
import settings from '../../config/settings';
import store from '../../store';
import config from '../configstore';
import serverManager from '../../lib/ServerManager';
import { MarlinController } from '../../controllers';
import { WRITE_SOURCE_CLIENT } from '../../controllers/constants';
import slice from '../../slicer/slice';
import TaskManager from '../task-manager';
import { IP_WHITELIST } from '../../constants';

const log = logger('service:socket-server');


class SocketServer {
    server = null;

    io = null;

    sockets = [];

    // @param {object} server The HTTP server instance.
    start(server) {
        this.stop();

        this.server = server;
        this.io = SocketIO(this.server, {
            serveClient: true,
            pingTimeout: 60000, // 60s without pong to consider the connection closed
            path: '/socket.io'
        });

        // JWT (JSON Web Tokens) support
        this.io.use(socketioJwt.authorize({
            secret: settings.secret,
            handshake: true
        }));

        // Register middleware that checks for client IP address and blocks connections
        // which are not in white list.
        this.io.use((socket, next) => {
            const clientIp = socket.handshake.address;
            const allowedAccess = IP_WHITELIST.some(whitelist => {
                return rangeCheck.inRange(clientIp, whitelist);
            }) || (settings.allowRemoteAccess);

            if (!allowedAccess) {
                log.warn(`Forbidden: Deny connection from ${clientIp}`);
                next(new Error('You are not allowed on this server!'));
                return;
            }

            next();
        });

        this.io.on('connection', (socket) => {
            const address = socket.handshake.address;
            const token = socket.decoded_token || {};
            log.debug(`New connection from ${address}: id=${socket.id}, token.id=${token.id}, token.name=${token.name}`);

            // Add to the socket pool
            this.sockets.push(socket);

            // connection startup
            socket.emit('startup');

            // Disconnect from socket
            socket.on('disconnect', () => {
                log.debug(`Disconnected from ${address}: id=${socket.id}, token.id=${token.id}, token.name=${token.name}`);

                const controllers = store.get('controllers', {});
                // Object.keys(controllers).forEach((port) => {
                Object.keys(controllers).forEach((portWithDataSource) => {
                    // const controller = controllers[port];
                    // const controller = controllers[`${portWithDataSource}`];
                    const controller = controllers[portWithDataSource];
                    if (!controller) {
                        return;
                    }
                    controller.removeConnection(socket);
                });

                // Remove from socket pool
                this.sockets.splice(this.sockets.indexOf(socket), 1);
            });

            // Bind event handlers when socket connected
            this.onConnection(socket);

            // 3D Printing slice
            // TODO: params explain
            socket.on('slice', (params) => {
                socket.emit('slice:started');
                slice(
                    params,
                    (progress) => {
                        socket.emit('slice:progress', progress);
                    },
                    (sliceResult) => {
                        const { gcodeFileName, printTime, filamentLength, filamentWeight, gcodeFilePath } = { ...sliceResult };
                        socket.emit('slice:completed', {
                            gcodeFileName,
                            printTime,
                            filamentLength,
                            filamentWeight,
                            gcodeFilePath
                        });
                    },
                    (err) => {
                        socket.emit('slice:error', err);
                    }
                );
            });

            // Discover Wi-Fi enabled Snapmakers
            socket.on('http:discover', () => {
                serverManager.refreshDevices();

                serverManager.once('devices', (devices) => {
                    socket.emit('discoverSnapmaker:devices', devices);
                });
            });

            // Task
            socket.on('task:commit', (task) => {
                const taskID = task.taskID;
                TaskManager.instance.addTask(task, taskID);
            });
            TaskManager.instance.on('taskProgress', (progress) => {
                socket.emit('task:progress', progress);
            });

            TaskManager.instance.removeAllListeners('taskCompleted');
            TaskManager.instance.on('taskCompleted', (task) => {
                socket.emit('task:completed', {
                    taskID: task.taskID,
                    status: task.taskStatus,
                    filename: task.filename
                });
            });

            socket.on('command', (port, dataSource, cmd, ...args) => {
                log.debug(`socket.command("${port}/${dataSource}", "${cmd}"): id=${socket.id}, args=${JSON.stringify(args)}`);

                const controller = store.get(`controllers["${port}/${dataSource}"]`);
                if (!controller || !controller.isOpen()) {
                    log.error(`Serial port "${port}/${dataSource}" not accessible`);
                    return;
                }

                controller.command(socket, cmd, ...args);
            });

            socket.on('writeln', (port, dataSource, data, context = {}) => {
                log.debug(`socket.writeln("${port}/${dataSource}", "${data}", ${JSON.stringify(context)}): id=${socket.id}`);
                const controller = store.get(`controllers["${port}/${dataSource}"]`);
                if (!controller || !controller.isOpen()) {
                    log.error(`Serial port "${port}/${dataSource}" not accessible`);
                    return;
                }

                if (!context.source) {
                    context.source = WRITE_SOURCE_CLIENT;
                }
                controller.writeln(data, context);
            });
        });

        serverManager.on('servers', (servers) => {
            for (const socket of this.sockets) {
                socket.emit('http:discover', servers);
            }
        });
    }

    stop() {
        if (this.io) {
            this.io.close();
            this.io = null;
        }
        this.sockets = [];
        this.server = null;
    }

    onConnection(socket) {
        // List available serial ports
        socket.on('serialport:list', () => {
            log.debug(`serialport:list(): id=${socket.id}`);

            serialport.list((err, ports) => {
                if (err) {
                    log.error(err);
                    return;
                }

                const allPorts = ports.concat(ensureArray(config.get('ports', [])));

                const controllers = store.get('controllers', {});
                const portsInUse = Object.keys(controllers)
                    // .filter(port => {
                    .filter((portWithDataSource) => {
                        const controller = controllers[portWithDataSource];
                        return controller && controller.isOpen();
                    });

                const availablePorts = allPorts.map(port => {
                    return {
                        port: port.comName,
                        manufacturer: port.manufacturer,
                        inuse: portsInUse.indexOf(port.comName) >= 0
                    };
                });
                socket.emit('serialport:list', { ports: availablePorts });
            });
        });

        // Open serial port
        socket.on('serialport:open', (port, dataSource) => {
            log.debug(`socket.open("${port}/${dataSource}"): socket=${socket.id}`);

            // let controller = store.get(`controllers["${port}"]`);
            let controller = store.get(`controllers["${port}/${dataSource}"]`);
            if (!controller) {
                controller = new MarlinController(port, dataSource, { baudrate: 115200 });
            }

            controller.addConnection(socket);
            // const controllers = store.get('controllers');

            if (controller.isOpen()) {
                log.debug('controller.isOpen() already');
                // Join the room
                socket.join(port);

                socket.emit('serialport:open', { port, dataSource });
                socket.emit('serialport:ready', { state: controller.controller.state, dataSource });
            } else {
                controller.open((err = null) => {
                    if (err) {
                        socket.emit('serialport:open', { port, dataSource, err });
                        return;
                    }

                    if (store.get(`controllers["${port}/${dataSource}"]`)) {
                        log.error(`Serial port "${port}/${dataSource}" was not properly closed`);
                    }
                    // store.set(`controllers["${port}"]`, controller);
                    store.set(`controllers["${port}/${dataSource}"]`, controller);

                    // Join the room
                    socket.join(port);

                    socket.emit('serialport:open', { port, dataSource });
                });
            }
        });

        // Close serial port
        socket.on('serialport:close', (port, dataSource) => {
            log.debug(`socket.close("${port}/${dataSource}"): id=${socket.id}`);

            const controller = store.get(`controllers["${port}/${dataSource}"]`);
            if (!controller) {
                const err = `Serial port "${port}/${dataSource}" not accessible`;
                log.error(err);
                socket.emit('serialport:close', { port, dataSource, err: new Error(err) });
                return;
            }

            // Leave the room
            socket.leave(port);

            controller.close();
            /*
            controller.close(() => {
                // Remove controller from store
                store.unset(`controllers["${port}/${dataSource}"]`);

                // Destroy controller
                controller.destroy();
            });
            */
        });

        // Discover Wi-Fi enabled Snapmaker 2
        socket.on('http:discover', () => {
            serverManager.refreshDevices();
        });
    }
}

export default SocketServer;