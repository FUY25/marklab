import SwiftUI

enum MarkLabAppSettings {
  static let localAutosaveEnabledDefaultsKey = "MarkLabLocalAutosaveEnabled"
  static let localAutosaveLabel = "Autosave Local Files"
  static let localAutosaveDescription = "Only applies when a file is not sharing. Shared documents sync automatically and create online version checkpoints."
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
