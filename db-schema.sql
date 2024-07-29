DROP TABLE IF EXISTS `partial_tx`;
CREATE TABLE `partial_tx` (
  `id` int NOT NULL,
  `proposer` varchar(255) NOT NULL,
  `accountFrom` varchar(255) NOT NULL,
  `expiration` datetime NOT NULL,
  `partialTx` json NOT NULL,
  `signedBy` text NOT NULL,
  `weightThreshold` int NOT NULL DEFAULT '0',
  `weightSigned` int NOT NULL DEFAULT '0',
  `dirty` tinyint(1) NOT NULL
);
ALTER TABLE `partial_tx`
  ADD PRIMARY KEY (`id`);
ALTER TABLE `partial_tx`
  MODIFY `id` int NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=23507;
COMMIT;
