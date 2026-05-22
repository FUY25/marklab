import SwiftUI

enum MarkLabAppSettings {
  static let localAutosaveEnabledDefaultsKey = "MarkLabLocalAutosaveEnabled"
  static let localAutosaveLabel = "Local Autosave"
  static let localAutosaveDescription = "Automatically save local-only Markdown edits after a short pause. Shared documents use realtime projection to the local file."
}

struct MarkLabSettingsView: View {
  @AppStorage(MarkLabAppSettings.localAutosaveEnabledDefaultsKey)
  private var localAutosaveEnabled = false

  var body: some View {
    Form {
      Section("Editing") {
        Toggle(MarkLabAppSettings.localAutosaveLabel, isOn: $localAutosaveEnabled)
        Text(MarkLabAppSettings.localAutosaveDescription)
          .font(.callout)
          .foregroundStyle(.secondary)
      }
    }
    .formStyle(.grouped)
    .padding(20)
    .frame(width: 440)
  }
}
