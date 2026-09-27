import { Response } from 'express';

export interface LogEntry {
  id: number;
  timestamp: string;
  level: 'info' | 'success' | 'warn' | 'error' | 'debug';
  category: string;
  message: string;
  data?: any;
}

class LoggerService {
  private logs: LogEntry[] = [];
  private sseClients: Set<Response> = new Set();
  private nextId = 1;
  private maxLogs = 300;

  constructor() {
    this.info('SISTEMA', 'Inicializando servicio de logs de BotArca...');
  }

  public addClient(res: Response) {
    this.sseClients.add(res);
    // Enviar últimos 50 logs al conectarse
    const recent = this.logs.slice(-50);
    res.write(`data: ${JSON.stringify({ type: 'history', logs: recent })}\n\n`);

    res.on('close', () => {
      this.sseClients.delete(res);
    });
  }

  public removeClient(res: Response) {
    this.sseClients.delete(res);
  }

  private log(level: LogEntry['level'], category: string, message: string, data?: any) {
    const entry: LogEntry = {
      id: this.nextId++,
      timestamp: new Date().toLocaleTimeString('es-AR', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      level,
      category,
      message,
      data,
    };

    this.logs.push(entry);
    if (this.logs.length > this.maxLogs) {
      this.logs.shift();
    }

    // Formato consola de Node
    const prefix = `[${entry.timestamp}] [${category}] [${level.toUpperCase()}]`;
    if (level === 'error') {
      console.error(prefix, message, data || '');
    } else if (level === 'warn') {
      console.warn(prefix, message, data || '');
    } else {
      console.log(prefix, message, data || '');
    }

    // Emitir a clientes web SSE
    const payload = JSON.stringify({ type: 'log', entry });
    for (const client of this.sseClients) {
      try {
        client.write(`data: ${payload}\n\n`);
      } catch (err) {
        this.sseClients.delete(client);
      }
    }
  }

  public info(category: string, message: string, data?: any) {
    this.log('info', category, message, data);
  }

  public success(category: string, message: string, data?: any) {
    this.log('success', category, message, data);
  }

  public warn(category: string, message: string, data?: any) {
    this.log('warn', category, message, data);
  }

  public error(category: string, message: string, data?: any) {
    this.log('error', category, message, data);
  }

  public debug(category: string, message: string, data?: any) {
    this.log('debug', category, message, data);
  }

  public getRecentLogs(limit: number = 100): LogEntry[] {
    return this.logs.slice(-limit);
  }
}

export const logger = new LoggerService();
