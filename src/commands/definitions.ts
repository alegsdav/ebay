import { SlashCommandBuilder, ChannelType } from "discord.js";
export const commands = [
  new SlashCommandBuilder()
    .setName("defaults")
    .setDescription(
      "Set your city or ZIP, radius in miles, and pickup/shipping; omit options to view",
    )
    .setDMPermission(false)
    .addStringOption((o) =>
      o
        .setName("city")
        .setDescription("US city and state, e.g. Portland, OR")
        .setMaxLength(100),
    )
    .addStringOption((o) =>
      o
        .setName("zipcode")
        .setDescription("Five-digit US ZIP code")
        .setMinLength(5)
        .setMaxLength(5),
    )
    .addIntegerOption((o) =>
      o
        .setName("radius")
        .setDescription("Search radius in miles (1–100)")
        .setMinValue(1)
        .setMaxValue(100),
    )
    .addStringOption((o) =>
      o
        .setName("delivery")
        .setDescription("Pickup, shipping, or either")
        .addChoices(
          { name: "Pickup", value: "pickup" },
          { name: "Shipping", value: "shipping" },
          { name: "Either", value: "either" },
        ),
    ),
  new SlashCommandBuilder()
    .setName("watch")
    .setDescription("Create and manage your deal watches")
    .setDMPermission(false)
    .addSubcommand((s) =>
      s
        .setName("create")
        .setDescription("Preview a natural-language watch")
        .addStringOption((o) =>
          o
            .setName("query")
            .setDescription("e.g. wireless gaming mice under $80")
            .setRequired(true)
            .setMaxLength(2000),
        )
        .addChannelOption((o) =>
          o
            .setName("channel")
            .setDescription("Alert destination (default: here)")
            .addChannelTypes(ChannelType.GuildText),
        ),
    )
    .addSubcommand((s) => s.setName("list").setDescription("List your watches"))
    .addSubcommand((s) =>
      s
        .setName("update")
        .setDescription(
          "Preview revised criteria; other settings stay unchanged",
        )
        .addStringOption((o) =>
          o.setName("id").setDescription("Watch ID").setRequired(true),
        )
        .addStringOption((o) =>
          o
            .setName("query")
            .setDescription("Complete replacement search criteria")
            .setRequired(true)
            .setMaxLength(2000),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName("pause")
        .setDescription("Pause a watch")
        .addStringOption((o) =>
          o.setName("id").setDescription("Watch ID").setRequired(true),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName("resume")
        .setDescription("Resume a watch")
        .addStringOption((o) =>
          o.setName("id").setDescription("Watch ID").setRequired(true),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName("delete")
        .setDescription("Delete a watch and its alert history")
        .addStringOption((o) =>
          o.setName("id").setDescription("Watch ID").setRequired(true),
        ),
    ),
  new SlashCommandBuilder()
    .setName("listing")
    .setDescription("Review saved alert evidence")
    .setDMPermission(false)
    .addSubcommand((s) =>
      s
        .setName("evaluate")
        .setDescription(
          "Preview a manually submitted Marketplace listing for research",
        )
        .addStringOption((o) =>
          o
            .setName("watch")
            .setDescription(
              "Your watch ID: category, comparable rules and fee assumptions",
            )
            .setRequired(true),
        )
        .addStringOption((o) =>
          o
            .setName("source")
            .setDescription("Listing source")
            .addChoices({ name: "Facebook Marketplace", value: "facebook" })
            .setRequired(true),
        )
        .addStringOption((o) =>
          o
            .setName("url")
            .setDescription("Marketplace item URL (never fetched)")
            .setRequired(true)
            .setMaxLength(1000),
        )
        .addStringOption((o) =>
          o
            .setName("title")
            .setDescription("Listing title")
            .setRequired(true)
            .setMaxLength(500),
        )
        .addNumberOption((o) =>
          o
            .setName("price")
            .setDescription("Current asking price in USD")
            .setRequired(true)
            .setMinValue(0)
            .setMaxValue(10000000),
        )
        .addStringOption((o) =>
          o
            .setName("location")
            .setDescription("City/postal area only; no street address")
            .setRequired(true)
            .setMaxLength(200),
        )
        .addStringOption((o) =>
          o
            .setName("condition")
            .setDescription("Explicitly stated condition; otherwise unknown")
            .addChoices(
              ...[
                "new",
                "open_box",
                "used",
                "refurbished",
                "for_parts",
                "unknown",
              ].map((value) => ({ name: value, value })),
            ),
        )
        .addStringOption((o) =>
          o
            .setName("notes")
            .setDescription(
              "Visible model, accessories and condition evidence; omit personal data",
            )
            .setMaxLength(4000),
        )
        .addNumberOption((o) =>
          o
            .setName("travel")
            .setDescription(
              "Estimated round-trip pickup cost in USD; default zero",
            )
            .setMinValue(0)
            .setMaxValue(100000),
        ),
    )
    .addSubcommand((s) =>
      s.setName("saved").setDescription("Retrieve alerts you saved for later"),
    )
    .addSubcommand((s) =>
      s
        .setName("details")
        .setDescription("Download full saved alert evidence")
        .addStringOption((o) =>
          o
            .setName("alert")
            .setDescription("Alert ID from footer")
            .setRequired(true),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName("dismiss")
        .setDescription("Dismiss an alert")
        .addStringOption((o) =>
          o.setName("alert").setDescription("Alert ID").setRequired(true),
        ),
    ),
  new SlashCommandBuilder()
    .setName("alert")
    .setDescription("Test alert presentation")
    .setDMPermission(false)
    .addSubcommand((s) =>
      s
        .setName("test")
        .setDescription("Show a private synthetic sample; no real opportunity"),
    ),
  new SlashCommandBuilder()
    .setName("stats")
    .setDescription("View your watch and processing counts")
    .setDMPermission(false),
  new SlashCommandBuilder()
    .setName("settings")
    .setDescription("Preview watch thresholds and delivery changes")
    .setDMPermission(false)
    .addStringOption((o) =>
      o.setName("id").setDescription("Watch ID").setRequired(true),
    )
    .addNumberOption((o) =>
      o
        .setName("discount")
        .setDescription("Minimum discount percent")
        .setMinValue(0)
        .setMaxValue(95),
    )
    .addNumberOption((o) =>
      o
        .setName("profit")
        .setDescription("Minimum estimated profit in USD")
        .setMinValue(0),
    )
    .addNumberOption((o) =>
      o
        .setName("confidence")
        .setDescription("Minimum extraction confidence")
        .setMinValue(0.5)
        .setMaxValue(1),
    )
    .addIntegerOption((o) =>
      o
        .setName("comparables")
        .setDescription("Minimum completed sales")
        .setMinValue(3)
        .setMaxValue(100),
    )
    .addIntegerOption((o) =>
      o
        .setName("lookback")
        .setDescription("Comparable lookback days")
        .setMinValue(1)
        .setMaxValue(365),
    )
    .addIntegerOption((o) =>
      o
        .setName("frequency")
        .setDescription("Polling / notification interval in minutes")
        .setMinValue(60)
        .setMaxValue(10080),
    )
    .addChannelOption((o) =>
      o
        .setName("channel")
        .setDescription("Strong deal channel")
        .addChannelTypes(ChannelType.GuildText),
    )
    .addChannelOption((o) =>
      o
        .setName("possible_channel")
        .setDescription("Optional channel for possible matches")
        .addChannelTypes(ChannelType.GuildText),
    )
    .addBooleanOption((o) =>
      o
        .setName("disable_possible")
        .setDescription("Silently store possible matches"),
    ),
].map((c) => c.toJSON());
