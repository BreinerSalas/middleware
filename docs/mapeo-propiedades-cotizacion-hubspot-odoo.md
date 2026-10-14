# Mapeo de propiedades de cotización: HubSpot <-> Odoo

Fuente HubSpot: `Propiedades cotización Visual Branding.xlsx` (35 propiedades, hojas Propiedades / Opciones / Alertas).
Fuente Odoo: `OdooTargetGateway`, `odooApiClient.js:259` y la sonda del 2026-08-21
(`scripts/probes/inspect-gastos-envio-fields.js`).

**Estado del documento:** borrador. Los nombres de campo de Odoo marcados como _por confirmar_ son inferencia por
nombre/etiqueta y deben verificarse con la sonda cuando haya acceso a la base de datos (ver última sección).

## Cómo se alimenta la cotización

El vendedor elige `pais_de_destino` en la Quote. Su valor es el `id` de un registro de `operation.costs`
(ej. 66 = "DDP Costa Rica"). Ese registro trae las tarifas y cargos de entrada. Según la hoja *Alertas* del Excel,
HubSpot calcula la cadena de impuestos a partir de esos insumos, así que **lo que falta traer son los insumos, no los
resultados**.

Esta lectura ocurre cuando se arma la cotización, antes de que exista la sale.order. La clave de búsqueda es el id
guardado en `pais_de_destino`, no una orden de venta.

## 1. Insumos que existen en `operation.costs`

| Propiedad HubSpot | Etiqueta | Campo Odoo (`operation.costs`) | Lo lee el middleware hoy | Estado |
|---|---|---|---|---|
| `cargos_extra_aduana` | Cargos extra de aduana | `extra_custom_charges` | Sí | Falta escribirlo a HubSpot |
| `gastos_duca_escaner` | Gastos DUCA, escáner y transmisión | `duca_scanner_transmission` | Sí | Falta escribirlo a HubSpot |
| `honorarios_agencia` | Honorarios de agencia destino | `destination_procedure` | Sí | Falta escribirlo a HubSpot |
| `costo_envio_doctos` | Envío de documentos a Finanzas | `finance_docs_shipping` | Sí | Falta escribirlo a HubSpot |
| `costo_trsf_enviada` | Costo de transferencia enviada | `trsf_cost` | Sí | Falta escribirlo a HubSpot |
| `costo_trsf_recibida` | Costo de transferencia recibida | `received_transfer` | Sí | Falta escribirlo a HubSpot |
| `porcentaje_financiamiento` | Porcentaje de financiamiento | `financing` | Sí | Falta escribirlo a HubSpot; confirmar escala (0.085 = 8.5 %) |
| `porcentaje_iva` | Porcentaje IVA | `iva` | **No** | Agregar a `listOperationCosts`; confirmar tipo |
| `porcentaje_seguro` | Porcentaje de seguro | `insurance` | **No** | Agregar a `listOperationCosts`; confirmar tipo |
| `porcentaje_dai` | Porcentaje DAI / Arancel | `dai` | **No** | Agregar a `listOperationCosts`; confirmar tipo |

Los 7 primeros están confirmados contra una orden real (S06643, `operation.costs` id 66). `iva`, `insurance` y `dai`
aparecieron en la sonda como campos del modelo, pero no se verificó si son porcentaje o monto.

## 2. Sin contraparte conocida en Odoo

| Propiedad HubSpot | Etiqueta | Qué falta saber |
|---|---|---|
| `prod_monto` | Mueble / Producto | Posible suma de las líneas de la cotización. La hoja *Alertas* avisa que hoy se captura aparte y puede no coincidir con la tabla de productos. |
| `flete_monto` | Flete | Si es captura manual o sale de un campo de Odoo que no mapeamos. |
| `otros_cargos` | Otros cargos | Igual que `flete_monto`. Alerta: si queda vacío rompe toda la cadena de impuestos; recomiendan valor por defecto 0. |

## 3. Calculadas en HubSpot (no se traen de Odoo)

| Propiedad HubSpot | Etiqueta | Origen |
|---|---|---|
| `monto_seguro` | Monto Seguro | Calculada en HubSpot (inferido) |
| `valor_base_cif` | Valor Base CIF | Calculada en HubSpot (inferido) |
| `base_cif_con_otros_cargos` | Base CIF con Otros Cargos | Calculada en HubSpot (confirmado por *Alertas*) |
| `arancel_dai` | Arancel DAI | Calculada en HubSpot (confirmado por *Alertas*) |
| `impuesto_iva` | Impuesto IVA | Calculada en HubSpot (confirmado por *Alertas*) |
| `total_impuestos_aduaneros` | Total Impuestos Aduaneros | Calculada en HubSpot (confirmado por *Alertas*) |
| `total_gastos_operativos_y_logisticos` | Total Gastos Operativos y Logísticos | Calculada en HubSpot (inferido) |
| `suma_prefinanciamiento` | Suma Pre-Financiamiento | Calculada en HubSpot (confirmado por *Alertas*) |
| `costo_financiero` | Costo Financiero | Calculada en HubSpot (confirmado por *Alertas*) |

**Uso sugerido de Odoo como control cruzado:** una vez creada la orden, comparar estos totales contra los que Odoo
calcula (`sale.order.destination_taxes`, `shipping.expense.finantial` y `total_operations`; también existen
`iva_totals`, `dai_totals` e `insurance_sv`, con fórmula aún sin confirmar). Si no coinciden, la fórmula de HubSpot
difiere de la de Odoo.

## 4. Ya sincronizadas hoy

| Propiedad HubSpot | Dirección | Notas |
|---|---|---|
| `pais_de_destino` | HubSpot -> Odoo | Valor = id de `operation.costs`; resuelve `country_expense` y la línea de Gastos de Envío |
| `incoterm_cotizacion` | HubSpot -> Odoo | Valor = id de `account.incoterms`; `resolveIncotermFromQuote` |
| `tipo_documento_cotizacion` | HubSpot -> Odoo | `resolveDocumentTypeFromQuote` |
| `id_presupuesto_odoo` | Odoo -> HubSpot | Id de la sale.order |
| `estado_presupuesto_odoo` | Odoo -> HubSpot | draft / sent / sale / done / cancel |
| `estado_facturacion_odoo` | Odoo -> HubSpot | Estado de facturación |
| `numero_orden_fabricacion` | Odoo -> HubSpot | Se limpia al cancelar la orden |

## 5. Sin relación con Odoo o sin decidir

| Propiedad HubSpot | Nota |
|---|---|
| `comercial` | No se sabe si mapea a `user_id` de Odoo |
| `fecha_entrega_estimada` | Sin mapeo conocido |
| `forma_pago` | Sin mapeo conocido |
| `unidad_medida` | Sin mapeo conocido |
| `ocultar_campos` | Solo presentación (qué bloques oculta la cotización) |
| `valor_contabilizado` | Propiedad solo de HubSpot, usada por un workflow de acumulado de cotizaciones |

## 6. Alertas del Excel que afectan este trabajo

- `otros_cargos` vacío rompe la cadena de impuestos. Valor por defecto recomendado: 0.
- País e incoterm guardan un id numérico, no el texto; el módulo de Datos comerciales todavía imprime el número.
- El incoterm se captura dos veces: dentro de `pais_de_destino` ("CIF Canada") y en `incoterm_cotizacion`. Dos fuentes
  pueden contradecirse.
- La base imponible lee `prod_monto`, no la suma de la tabla de productos.

## 7. Qué verificar cuando haya acceso a Odoo

1. Correr `node scripts/probes/inspect-gastos-envio-fields.js <nombre de una orden>` (solo lectura) y **guardar la
   salida completa en `docs/`**. Esa corrida lista todos los campos de `operation.costs` con `fields_get`.
2. Confirmar nombre y tipo de `iva`, `insurance` y `dai` (porcentaje o monto) y la escala de `financing`.
3. Buscar en la lista completa un campo de flete y uno de otros cargos que cubran `flete_monto` y `otros_cargos`.
4. Confirmar que las fórmulas de HubSpot reproducen `destination_taxes` de Odoo para un registro real.
