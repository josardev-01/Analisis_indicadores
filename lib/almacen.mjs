// Persistencia en un único archivo JSON. Sin dependencias: alcanza para un
// diario personal de una sola persona en una sola máquina.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const VACIO = () => ({ cuentas: [], operaciones: [], movimientos: [] });

export class Almacen {
  constructor(ruta) {
    this.ruta = ruta;
    this.datos = VACIO();
    this.cola = Promise.resolve();
  }

  async cargar() {
    try {
      const crudo = JSON.parse(await readFile(this.ruta, 'utf8'));
      this.datos = { ...VACIO(), ...crudo };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.datos = VACIO();
    }
    return this.datos;
  }

  /** Escritura atómica (temporal + rename) y serializada para no pisar escrituras. */
  guardar() {
    this.cola = this.cola.then(async () => {
      await mkdir(dirname(this.ruta), { recursive: true });
      const temporal = `${this.ruta}.tmp`;
      await writeFile(temporal, JSON.stringify(this.datos, null, 2), 'utf8');
      await rename(temporal, this.ruta);
    });
    return this.cola;
  }

  reemplazar(datos) {
    this.datos = { ...VACIO(), ...datos };
    return this.guardar();
  }
}
