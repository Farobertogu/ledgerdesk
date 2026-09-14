// Independently fixed preserved-original identities from the reception case set.
export const originals = Object.freeze(Object.fromEntries([
  ['text.txt', 197, 'eca7253801e939ccdf6ea63e5bf1b1b59dbed50c27ebf4281b8abb5e4100bf3b'],
  ['bom.txt', 17, '8ab8151d61e1d71204824d7cbc2cfa3f2718028368ac812a260bc86ea26b42f9'],
  ['inert.md', 113, 'c55670721c52a62da1442513846cf40f1a3d399a2d20a1420c603c459ace902d'],
  ['table.csv', 117, '947da2ccc6b51f26df323a294f913b527393bfbec8c84e7349a3a407662b3be3'],
  ['bom.csv', 30, '81a3033aa2727d32d2156216c9ea54c241b09ac1caceb8fb45feb97bf6841b0a'],
  ['unicode-records.csv', 64, '845ce7ee594e76dba1e7c49337f73170653921003dbf1fdcc9b77c7b6f0ed150'],
  ['at-byte-limit.txt', 1048576, '8f990ba0b577b51cf009ea049368c16bbda1b21e1b93be07a824758bb253c39b'],
  ['over-byte-limit.txt', 1048577, '154b8ed3c2383ce429058768595935faf7851b5c38db2b1732594be1d88bc05a'],
  ['short.txt', 3, '38178a20b470cfd18299fb1593dd4ba706f1a83321dac051d01086efd8b7a96f'],
  ['baseline.xlsx', 4564, '41667ef76c98f71f8add0d4058c287b6a8b3965b87b3f23904c455cbd6410093'],
  ['cache-discrepant.xlsx', 4564, '069e6f5817c12c780c6013207b7d23e351cfc6cb0b7b6a8540a21522ef9c2136'],
  ['cache-missing.xlsx', 4560, 'ab5874f106bd541f89f344752537e9820e8010aaaaaf851435e7d484a35e6b7e'],
  ['cache-zero.xlsx', 4561, '6802f9d9f4fd61c78508b89474a5477c50012052484d5f688fc5dd177fcae783'],
  ['unsupported-part.xlsx', 4862, '147ef087a2f0e6f7fb708839390b26d1e727397ead28a3c14eaa0bc194da8e52'],
  ['broken-quotes.csv', 20, 'dcb9fbf7e5aefe74a496c2a133ba62a1bbe9c36f5bb8c7492ccfa8d444a62079'],
  ['invalid-utf8.txt', 8, '05fb00156e49da3702a3a26a5416ffc684483d45e36d4175a792a1928f1cc17a'],
].map(([name, bytes, sha256]) => [name, Object.freeze({ bytes, sha256 })])));

export const base = '364ec1f458e396f36fcfe9b19e33da59c0e7728a';
export const originalLimit = 1048576;
