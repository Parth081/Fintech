// FICTIONAL CONSOLIDATED LIST: the synthetic sanctions / watch list screened by the screening stage.
//
// EVERY name, alias, date and jurisdiction below is invented for the demo. The jurisdictions use the ISO
// 3166 user-assigned code range (XA-XZ) so no real country is ever associated with a listing:
//   XR Republic of Varnia   XS Sel Morra   XT Tarvos Federation   XQ Free Port of Qessan   XU Ulvar Isles
// Pure data (no imports): safe to use from the browser, the orchestrator scenarios and tests.

export const SANCTIONS_LIST_NAME = 'FICTIONAL CONSOLIDATED LIST' as const;
/** Bumped whenever an entry changes. Carried in payment.screened.listVersion. */
export const SANCTIONS_LIST_VERSION = 'fictional-sanctions-2026.2' as const;

export const FICTIONAL_JURISDICTIONS: Readonly<Record<string, string>> = {
  XR: 'Republic of Varnia',
  XS: 'Sel Morra',
  XT: 'Tarvos Federation',
  XQ: 'Free Port of Qessan',
  XU: 'Ulvar Isles',
};

export interface SanctionsEntry {
  /** Stable list reference, e.g. "FCL-0007". */
  id: string;
  type: 'individual' | 'entity';
  /** Primary name as listed (individuals: "SURNAME, Given Names"). */
  name: string;
  aliases: readonly string[];
  /** Fictional jurisdictions (XA-XZ user-assigned codes). */
  countries: readonly string[];
  /** Fictional sanctions programme. */
  program: string;
  listedOn: string; // YYYY-MM-DD
  remarks?: string;
}

const e = (
  id: number,
  type: SanctionsEntry['type'],
  name: string,
  aliases: string[],
  countries: string[],
  program: string,
  listedOn: string,
  remarks?: string,
): SanctionsEntry => ({ id: `FCL-${String(id).padStart(4, '0')}`, type, name, aliases, countries, program, listedOn, ...(remarks ? { remarks } : {}) });

export const FICTIONAL_SANCTIONS_LIST: readonly SanctionsEntry[] = [
  // Entries the M4 demo scenarios use (tools/traffic/risk.ts SANCTIONS_NEAR_MATCHES spell them differently).
  e(1, 'entity', 'VOLKOV MARITIME HOLDINGS', ['Volkov Shipping Holdings', 'VMH Bulk Carriers'], ['XR'], 'VARNIA-MARITIME', '2025-03-14', 'Sanctions-evasion shipping network'),
  e(2, 'individual', 'MORVANE, Dariusz Kael', ['Darek Morvane', 'D. K. Morvane'], ['XR', 'XQ'], 'VARNIA-MARITIME', '2025-03-14', 'Beneficial owner of FCL-0001'),
  e(3, 'entity', 'OBSIDIAN CRESCENT GENERAL TRADING FZE', ['Obsidian Crescent Trading', 'OCGT FZE'], ['XQ'], 'QESSAN-PROLIFERATION', '2024-11-02', 'Procurement front company'),
  e(4, 'individual', 'ASHGROVE-MALIK, Severin', ['Severin Malik', 'Sev Ashgrove'], ['XS'], 'SELMORRA-CORRUPTION', '2025-06-30'),
  e(5, 'entity', 'NORTHWIND PETROCHEMICAL COMPANY', ['Northwind Petrochem', 'NWPC'], ['XT'], 'TARVOS-ENERGY', '2024-08-19'),
  // Individuals
  e(6, 'individual', 'KASPARIAN, Teodor Valek', ['Teo Kasparian'], ['XR'], 'VARNIA-REGIME', '2023-02-11'),
  e(7, 'individual', 'VRANEK, Ludmila Oksana', ['Ludmila Vranek-Sorel'], ['XR'], 'VARNIA-REGIME', '2023-02-11'),
  e(8, 'individual', 'SZEMERYN, Aurel Bogdan', [], ['XR'], 'VARNIA-REGIME', '2023-05-27'),
  e(9, 'individual', 'QALDARI, Yusri Ammon', ['Yusri al-Qaldari'], ['XQ'], 'QESSAN-PROLIFERATION', '2024-01-09'),
  e(10, 'individual', 'TERZHAVIN, Nikolai Orest', ['Kolya Terzhavin'], ['XT'], 'TARVOS-ENERGY', '2024-08-19'),
  e(11, 'individual', 'MBEKARRO, Celestin Obi', [], ['XU'], 'ULVAR-ARMS', '2022-10-04'),
  e(12, 'individual', 'ZOLTAREV, Ilya Marek', ['Ilia Zoltarev'], ['XR', 'XT'], 'VARNIA-MARITIME', '2025-03-14'),
  e(13, 'individual', 'HADRANI, Samir Elzar', [], ['XQ'], 'QESSAN-TERROR-FINANCE', '2021-07-22'),
  e(14, 'individual', 'OKONDRE, Faustin Lemba', [], ['XU'], 'ULVAR-ARMS', '2022-10-04'),
  e(15, 'individual', 'DRAVOSKI, Mirela Anka', ['Mira Dravoski'], ['XS'], 'SELMORRA-CORRUPTION', '2025-06-30'),
  e(16, 'individual', 'PELLANDRO, Victor Amadeo', ['Vico Pellandro'], ['XS'], 'SELMORRA-CORRUPTION', '2023-09-15'),
  e(17, 'individual', 'XANTHOPOULIS, Kyros Demetri', [], ['XT'], 'TARVOS-ENERGY', '2024-12-01'),
  e(18, 'individual', 'BELARMINE, Odile Fortunee', [], ['XS'], 'SELMORRA-CORRUPTION', '2025-01-20'),
  e(19, 'individual', 'RUSTAVELIK, Gavril Ermak', [], ['XR'], 'VARNIA-REGIME', '2023-05-27'),
  e(20, 'individual', 'AZMERIQ, Tariq Solen', ['Tariq Azmerik'], ['XQ'], 'QESSAN-TERROR-FINANCE', '2021-07-22'),
  e(21, 'individual', 'KORVALENKO, Stanislav Igor', ['Stas Korvalenko'], ['XR'], 'VARNIA-CYBER', '2025-09-08', 'Ransomware proceeds laundering'),
  e(22, 'individual', 'NAZIMOVA, Elvira Rashid', [], ['XT'], 'TARVOS-ENERGY', '2024-12-01'),
  e(23, 'individual', 'OYELARAN, Babatunde Kole', ['Tunde Oyelaran'], ['XU'], 'ULVAR-ARMS', '2023-03-03'),
  e(24, 'individual', 'VESPERINI, Lorenzo Cassio', [], ['XS'], 'SELMORRA-NARCOTICS', '2022-06-17'),
  e(25, 'individual', 'GRISHAKOV, Pavel Anatol', [], ['XR'], 'VARNIA-CYBER', '2025-09-08'),
  e(26, 'individual', 'HALVORSEN-KRUG, Ingrid Mette', [], ['XU'], 'ULVAR-ARMS', '2024-04-12'),
  e(27, 'individual', 'MAKAREVIK, Zoran Iliya', ['Zoran Makarevich'], ['XR'], 'VARNIA-MARITIME', '2025-03-14'),
  e(28, 'individual', 'SOLTANZADEH, Kamran Fereyd', [], ['XQ'], 'QESSAN-PROLIFERATION', '2024-01-09'),
  e(29, 'individual', 'DELACROIX-NUNEZ, Esteban Raul', ['El Tasador'], ['XS'], 'SELMORRA-NARCOTICS', '2022-06-17'),
  e(30, 'individual', 'TOVMASIAN, Arpine Lusik', [], ['XT'], 'TARVOS-ENERGY', '2024-12-01'),
  e(31, 'individual', 'KRALJEVAC, Bojan Tomislav', [], ['XR'], 'VARNIA-REGIME', '2023-02-11'),
  e(32, 'individual', 'UMBERTAZZI, Fiorella Nives', [], ['XS'], 'SELMORRA-NARCOTICS', '2023-09-15'),
  // Entities
  e(33, 'entity', 'ZAREVSK INDUSTRIAL BANK', ['ZIB Varnia', 'Zarevsk Industrialny Bank'], ['XR'], 'VARNIA-REGIME', '2023-02-11'),
  e(34, 'entity', 'QESSAN FREE ZONE PRECISION MACHINERY', ['QFZ Precision'], ['XQ'], 'QESSAN-PROLIFERATION', '2024-01-09'),
  e(35, 'entity', 'TARVOS NATIONAL OIL EXPORT AGENCY', ['TNOEA', 'Tarvos Oil Export'], ['XT'], 'TARVOS-ENERGY', '2024-08-19'),
  e(36, 'entity', 'SILVERFEN CAPITAL MANAGEMENT', ['Silverfen Capital'], ['XS'], 'SELMORRA-CORRUPTION', '2025-06-30'),
  e(37, 'entity', 'ULVAR DEFENCE SYSTEMS CONSORTIUM', ['UDSC'], ['XU'], 'ULVAR-ARMS', '2022-10-04'),
  e(38, 'entity', 'KRASNOGOR SHIPPING AND FREIGHT', ['Krasnogor Freight'], ['XR'], 'VARNIA-MARITIME', '2025-03-14'),
  e(39, 'entity', 'AMBERLOCK EXCHANGE HOUSE', ['Amberlock Remittance', 'Amberlock FX'], ['XQ'], 'QESSAN-TERROR-FINANCE', '2021-07-22', 'Unlicensed money transmitter'),
  e(40, 'entity', 'VELMORA MINING CONSOLIDATED', ['Velmora Mining'], ['XU'], 'ULVAR-ARMS', '2023-03-03'),
  e(41, 'entity', 'BLACKSPIRE CYBER SOLUTIONS', ['Blackspire Labs'], ['XR'], 'VARNIA-CYBER', '2025-09-08'),
  e(42, 'entity', 'HELIOGRAD ENERGY TRADING', ['Heliograd Energy'], ['XT'], 'TARVOS-ENERGY', '2024-12-01'),
  e(43, 'entity', 'CORVANTE PHARMACEUTICAL WORKS', ['Corvante Pharma'], ['XS'], 'SELMORRA-NARCOTICS', '2022-06-17'),
  e(44, 'entity', 'MERIDIAN STRAIT TANKERS', ['Meridian Strait Shipping'], ['XQ', 'XR'], 'VARNIA-MARITIME', '2025-03-14'),
  e(45, 'entity', 'ORLOVKA AVIATION SERVICES', ['Orlovka Air'], ['XR'], 'VARNIA-REGIME', '2023-05-27'),
  e(46, 'entity', 'SABLEWATCH SECURITY GROUP', ['Sablewatch'], ['XU'], 'ULVAR-ARMS', '2024-04-12'),
  e(47, 'entity', 'GOLDEN DUNE BULLION FZCO', ['Golden Dune Gold'], ['XQ'], 'QESSAN-TERROR-FINANCE', '2024-01-09'),
  e(48, 'entity', 'TERRANOVA DIGITAL ASSETS EXCHANGE', ['Terranova DAX'], ['XS'], 'VARNIA-CYBER', '2025-09-08', 'Crypto-asset mixing service'),
  e(49, 'entity', 'VASKOV ENGINEERING BUREAU', ['Vaskov KB'], ['XR'], 'VARNIA-REGIME', '2023-02-11'),
  e(50, 'entity', 'PYRENEX CHEMICAL INDUSTRIES', ['Pyrenex Chemicals'], ['XT'], 'QESSAN-PROLIFERATION', '2024-11-02'),
  e(51, 'entity', 'ISTRAVEL TRANSIT HOLDINGS', [], ['XS'], 'SELMORRA-NARCOTICS', '2023-09-15'),
  e(52, 'entity', 'MARROWGATE INVESTMENT TRUST', ['Marrowgate Trust'], ['XU'], 'SELMORRA-CORRUPTION', '2025-01-20'),
  e(53, 'entity', 'DRAKKAR LOGISTICS INTERNATIONAL', ['Drakkar Logistics'], ['XR', 'XU'], 'VARNIA-MARITIME', '2025-03-14'),
  e(54, 'entity', 'ZENOBIA ARMS TRADING', ['Zenobia Defence'], ['XU'], 'ULVAR-ARMS', '2022-10-04'),
  e(55, 'entity', 'QUORVANT TELECOM SYSTEMS', ['Quorvant Telecom'], ['XT'], 'VARNIA-CYBER', '2025-09-08'),
  e(56, 'entity', 'BALTRAZAR COMMODITIES SA', ['Baltrazar Commodities'], ['XS'], 'SELMORRA-CORRUPTION', '2025-06-30'),
  e(57, 'entity', 'NEVSKAYA RIVER PORT AUTHORITY', [], ['XR'], 'VARNIA-REGIME', '2023-05-27'),
  e(58, 'entity', 'QARIM HAWALA NETWORK', ['Qarim Money Transfer'], ['XQ'], 'QESSAN-TERROR-FINANCE', '2021-07-22', 'Informal value transfer system'),
  e(59, 'entity', 'OSTRAVIN HEAVY MACHINERY PLANT', ['Ostravin Machinery'], ['XT'], 'TARVOS-ENERGY', '2024-08-19'),
  e(60, 'entity', 'LUMERIA OFFSHORE SERVICES', ['Lumeria Offshore'], ['XU', 'XQ'], 'SELMORRA-CORRUPTION', '2025-01-20'),
  e(61, 'entity', 'VORTEXA SHELL HOLDINGS', ['Vortexa Holdings'], ['XS'], 'SELMORRA-CORRUPTION', '2025-06-30'),
  e(62, 'individual', 'TRAVNIKOVA, Anastasia Petra', ['Nastya Travnikova'], ['XR'], 'VARNIA-CYBER', '2025-09-08'),
];

export function sanctionsEntryById(id: string): SanctionsEntry | undefined {
  return FICTIONAL_SANCTIONS_LIST.find((x) => x.id === id);
}
