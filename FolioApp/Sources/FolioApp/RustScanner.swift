import Foundation

actor MediaScanner {
    private let fileManager = FileManager.default

    func scan(url: URL) async throws -> ScanResult {
        if let scannerURL = scannerExecutableURL() {
            do {
                return try runRustScanner(scannerURL: scannerURL, folderURL: url)
            } catch {
                return try swiftScan(url: url)
            }
        }
        return try swiftScan(url: url)
    }

    private func scannerExecutableURL() -> URL? {
        let environment = ProcessInfo.processInfo.environment
        if let explicitPath = environment["FOLIO_SCANNER_PATH"], fileManager.isExecutableFile(atPath: explicitPath) {
            return URL(fileURLWithPath: explicitPath)
        }

        let current = URL(fileURLWithPath: fileManager.currentDirectoryPath)
        let candidates = [
            current.appendingPathComponent("target/release/folio-scanner"),
            current.appendingPathComponent("target/debug/folio-scanner"),
            current.appendingPathComponent("core/folio-scanner/target/release/folio-scanner"),
            current.appendingPathComponent("core/folio-scanner/target/debug/folio-scanner")
        ]

        return candidates.first { fileManager.isExecutableFile(atPath: $0.path) }
    }

    private func runRustScanner(scannerURL: URL, folderURL: URL) throws -> ScanResult {
        let process = Process()
        let output = Pipe()
        let error = Pipe()

        process.executableURL = scannerURL
        process.arguments = [folderURL.path]
        process.standardOutput = output
        process.standardError = error

        try process.run()
        process.waitUntilExit()

        guard process.terminationStatus == 0 else {
            let data = error.fileHandleForReading.readDataToEndOfFile()
            let message = String(data: data, encoding: .utf8) ?? "scanner failed"
            throw NSError(domain: "FolioScanner", code: Int(process.terminationStatus), userInfo: [
                NSLocalizedDescriptionKey: message
            ])
        }

        let data = output.fileHandleForReading.readDataToEndOfFile()
        return try JSONDecoder().decode(ScanResult.self, from: data)
    }

    private func swiftScan(url: URL) throws -> ScanResult {
        let keys: Set<URLResourceKey> = [.isRegularFileKey, .isDirectoryKey, .fileSizeKey, .contentModificationDateKey]
        let enumerator = fileManager.enumerator(
            at: url,
            includingPropertiesForKeys: Array(keys),
            options: [.skipsHiddenFiles, .skipsPackageDescendants]
        )

        var items: [MediaItem] = []
        items.reserveCapacity(2048)

        while let fileURL = enumerator?.nextObject() as? URL {
            let values = try? fileURL.resourceValues(forKeys: keys)
            guard values?.isRegularFile == true else { continue }
            guard fileURL.isDisplayableImage else { continue }

            let modified = Int64(values?.contentModificationDate?.timeIntervalSince1970 ?? 0)
            let size = UInt64(values?.fileSize ?? 0)
            items.append(MediaItem(path: fileURL.path, name: fileURL.lastPathComponent, size: size, modified: modified))
        }

        items.sort { lhs, rhs in
            if lhs.modified == rhs.modified { return lhs.name < rhs.name }
            return lhs.modified > rhs.modified
        }

        return ScanResult(root: url.path, count: items.count, items: items)
    }
}

