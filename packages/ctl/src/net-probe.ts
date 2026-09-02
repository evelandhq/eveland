import net from "node:net";

export type TcpProbe = (host: string, port: number) => Promise<boolean>;

export function defaultTcpProbe(): TcpProbe {
  return (host, port) =>
    new Promise((resolve) => {
      const socket = net.connect({ host, port, timeout: 2_000 });
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      const fail = () => {
        socket.destroy();
        resolve(false);
      };
      socket.once("timeout", fail);
      socket.once("error", fail);
    });
}
