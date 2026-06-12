import { world, system } from "@minecraft/server";
import { ActionFormData, MessageFormData } from "@minecraft/server-ui";

const hitCounts = new Map();
const lastBedSearch = new Map(); // entityId → { tick, foundBed, onBed, targetBed }

function getWeaponTier(typeId) {
    if (typeId.includes("netherite") || typeId.includes("diamond")) return "heavy";
    if (typeId.includes("iron") || typeId.includes("stone")) return "medium";
    return "light";
}

// ==========================================
// 1. Hệ thống AI chính (đi lại, ngủ, tìm giường, và hút đồ vật)
// ==========================================
system.runInterval(() => {
    const time = world.getTimeOfDay();
    const isNight = (time > 13000 && time < 23500); 

    const overworld = world.getDimension("overworld");
    const penguins = overworld.getEntities({ type: "custom:gugugaga_penguin" });
    const claimedBeds = new Set();

    for (const penguin of penguins) {
        const isForcedSleep = penguin.hasTag("is_forced_sleep");
        const isSitting = penguin.hasTag("is_sitting");
        const isSleepy = isNight || isForcedSleep;

        const loc = penguin.location;
        const dim = penguin.dimension;

        if (!isNight && isForcedSleep) {
            penguin.removeTag("is_forced_sleep");
        }

                const inventory = penguin.getComponent("minecraft:inventory");
        if (inventory && inventory.container) {
            const container = inventory.container;

                        // 🌟 Hệ thống hút đồ: chỉ hút được khi "không đang thả đồ" (is_dropping)
            if (container.emptySlotsCount > 0 && !penguin.hasTag("is_dropping")) {
                try {
                    const droppedItems = dim.getEntities({ type: "minecraft:item", location: loc, maxDistance: 1.5 });
                    for (const itemEntity of droppedItems) {
                        const itemComp = itemEntity.getComponent("minecraft:item");
                        if (itemComp && itemComp.itemStack) {
                            const leftover = container.addItem(itemComp.itemStack);
                            itemEntity.remove();
                            dim.playSound("random.pop", loc, { volume: 0.8, pitch: 1.5 });
                            if (leftover) {
                                dim.spawnItem(leftover, loc);
                                break;
                            }
                        }
                    }
                } catch(e) {}
            }

            // 🚨 Hệ thống cảnh báo túi đồ đầy
            if (container.emptySlotsCount === 0) {
                if (!penguin.hasTag("inv_full_alert")) {
                    penguin.addTag("inv_full_alert");
                    const players = dim.getPlayers({ location: loc, maxDistance: 15 });
                    for (const p of players) {
                        p.sendMessage("§c🚨 [Cảnh báo] Gugugaga: Chủ ơi! Túi của con đầy ứ hết rồi ạ! 🐧🎒");
                        p.playSound("note.bass", { volume: 1.0, pitch: 0.5 });
                    }
                }
            } else {
                penguin.removeTag("inv_full_alert");
            }

            // 📥 Hệ thống đổ đồ vào Hopper
            try {
                const blockUnder = dim.getBlock({ x: Math.floor(loc.x), y: Math.floor(loc.y - 0.2), z: Math.floor(loc.z) });
                if (blockUnder && blockUnder.typeId === "minecraft:hopper") {
                    let droppedAny = false;
                    for (let i = 0; i < container.size; i++) {
                        const item = container.getItem(i);
                        if (item) {
                            dim.spawnItem(item, { x: loc.x, y: loc.y + 0.5, z: loc.z });
                            container.setItem(i, undefined);
                            droppedAny = true;
                        }
                    }
                    if (droppedAny) dim.playSound("random.pop", loc, { volume: 1.0 });
                }
            } catch(e) {}
        }

        // ----- Hệ thống tìm giường và đi ngủ (throttle scan mỗi 3 giây) -----
        const tick = system.currentTick;
        if (isSleepy) {
            const cached = lastBedSearch.get(penguin.id);
            let foundBed  = cached?.foundBed  ?? false;
            let onBed     = cached?.onBed     ?? false;
            let targetBed = cached?.targetBed ?? null;

            if (!cached || (tick - cached.tick) >= 60) {
                foundBed = false; onBed = false; targetBed = null;
                const searchRadius = 16;
                outer: for (let x = -searchRadius; x <= searchRadius; x++) {
                    for (let y = -3; y <= 3; y++) {
                        for (let z = -searchRadius; z <= searchRadius; z++) {
                            try {
                                const bedX = Math.floor(loc.x) + x;
                                const bedY = Math.floor(loc.y) + y;
                                const bedZ = Math.floor(loc.z) + z;
                                const bedKey = `${bedX},${bedY},${bedZ}`;
                                const block = dim.getBlock({ x: bedX, y: bedY, z: bedZ });
                                if (block && block.typeId.includes("bed")) {
                                    if (claimedBeds.has(bedKey)) continue;
                                    foundBed = true;
                                    if (Math.abs(x) <= 3 && Math.abs(y) <= 3 && Math.abs(z) <= 3) {
                                        onBed = true;
                                        let bedRotY = penguin.getRotation().y;
                                        try {
                                            const bedDir = block.permutation.getState("direction");
                                            if (bedDir === 0) bedRotY = 0; else if (bedDir === 1) bedRotY = 90;
                                            else if (bedDir === 2) bedRotY = 180; else if (bedDir === 3) bedRotY = -90;
                                        } catch(e) {}
                                        targetBed = { x: bedX, y: bedY, z: bedZ, rotY: bedRotY };
                                        break outer;
                                    } else if (!targetBed) {
                                        targetBed = { x: bedX, y: bedY, z: bedZ };
                                    }
                                }
                            } catch(e) {}
                        }
                    }
                }
                lastBedSearch.set(penguin.id, { tick, foundBed, onBed, targetBed });
            }

            if (foundBed && targetBed) {
                const tx = targetBed.x; const ty = targetBed.y; const tz = targetBed.z;
                claimedBeds.add(`${tx},${ty},${tz}`); claimedBeds.add(`${tx+1},${ty},${tz}`);
                claimedBeds.add(`${tx-1},${ty},${tz}`); claimedBeds.add(`${tx},${ty},${tz+1}`);
                claimedBeds.add(`${tx},${ty},${tz-1}`);
            }

            if (onBed && targetBed) {
                if (!penguin.hasTag("state_sleep")) {
                    penguin.addTag("state_sleep"); penguin.removeTag("state_wake"); penguin.removeTag("state_finding_bed"); 
                    try { penguin.teleport({ x: targetBed.x + 0.5, y: targetBed.y + 0.15, z: targetBed.z + 0.5 }, { dimension: dim, rotation: { x: 0, y: targetBed.rotY } }); } catch(e) {}
                    penguin.triggerEvent("gugugaga:sleep_now");
                }
            } else if (foundBed) {
                if (!penguin.hasTag("state_finding_bed")) {
                    penguin.addTag("state_finding_bed"); penguin.removeTag("state_sleep"); penguin.removeTag("state_wake");
                    penguin.triggerEvent("gugugaga:move_to_bed");
                }
            } else {
                if (!penguin.hasTag("state_wake")) {
                    penguin.addTag("state_wake"); penguin.removeTag("state_sleep"); penguin.removeTag("state_finding_bed");
                    penguin.triggerEvent(isSitting ? "gugugaga:sit" : "gugugaga:follow");
                }
                if (Math.random() < 0.15) dim.playSound("mob.gugugaga.cry", loc, { volume: 1.0 });
            }
        } else {
            if (penguin.hasTag("state_sleep") || penguin.hasTag("state_wake") || penguin.hasTag("state_finding_bed")) {
                penguin.removeTag("state_sleep"); penguin.removeTag("state_wake"); penguin.removeTag("state_finding_bed");
                penguin.triggerEvent(isSitting ? "gugugaga:sit" : "gugugaga:follow");
            }
            if (Math.random() < 0.10) dim.playSound("mob.gugugaga.idle", loc, { volume: 1.0 });
        }

    }
}, 20);

// ==========================================
// 2. Hệ thống bị đánh / âm thanh đau đớn
// ==========================================
world.afterEvents.entityHurt.subscribe((event) => {
    // Vệ sĩ: phản công khi CHỦ bị đánh
    const victim = event.hurtEntity;
    const attacker = event.damageSource?.damagingEntity;

    if (victim?.typeId === "minecraft:player" && attacker) {
    const nearbyPenguins = victim.dimension.getEntities({
        type: "custom:gugugaga_penguin",
        location: victim.location,
        maxDistance: 16
    });
    for (const pg of nearbyPenguins) {
        if (!pg.hasTag("job_guard")) continue;
        try {
            // Entity.target là readonly trong Script API 1.8.0
            // Kích hoạt guard mode để behavior AI tự tìm target
            pg.triggerEvent("gugugaga:enable_guard");
            // Teleport nhẹ về phía kẻ tấn công để AI nhận diện
            const atLoc = attacker.location;
            const pgLoc = pg.location;
            const dx = atLoc.x - pgLoc.x;
            const dz = atLoc.z - pgLoc.z;
            const len = Math.sqrt(dx*dx + dz*dz) || 1;
            pg.teleport(
                { x: pgLoc.x + (dx/len)*1.5, y: pgLoc.y, z: pgLoc.z + (dz/len)*1.5 },
                { dimension: pg.dimension, rotation: pg.getRotation() }
            );
        } catch(e) {}
    }
}

    const entity = event.hurtEntity;
    if (entity.typeId === "custom:gugugaga_penguin") {
        let hits = (hitCounts.get(entity.id) || 0) + 1;
        hitCounts.set(entity.id, hits);
        if (hits > 5) entity.dimension.playSound("mob.gugugaga.cry", entity.location, { volume: 1.0 });
        else entity.dimension.playSound("mob.gugugaga.hurt", entity.location, { volume: 1.0 });
    }
});

world.afterEvents.entityDie.subscribe((event) => {
    const entity = event.deadEntity;
    if (entity.typeId === "custom:gugugaga_penguin") {
        hitCounts.delete(entity.id);
        lastBedSearch.delete(entity.id);
        entity.dimension.playSound("mob.gugugaga.death", entity.location, { volume: 1.0 });
    }
});

// ==========================================
// 3. Quản lý UI (túi đồ / điều khiển)
// ==========================================
world.afterEvents.playerInteractWithEntity.subscribe((event) => {
    const player = event.player;
    const target = event.target;

    if (target.typeId === "custom:gugugaga_penguin") {
        const isSitting = target.hasTag("is_sitting");
        const item = event.itemStack;

        const WEAPON_TYPES = [
            "minecraft:wooden_sword", "minecraft:stone_sword", "minecraft:iron_sword", "minecraft:golden_sword", "minecraft:diamond_sword", "minecraft:netherite_sword",
            "minecraft:wooden_axe", "minecraft:stone_axe", "minecraft:iron_axe", "minecraft:golden_axe", "minecraft:diamond_axe", "minecraft:netherite_axe",
            "minecraft:wooden_pickaxe", "minecraft:stone_pickaxe", "minecraft:iron_pickaxe", "minecraft:golden_pickaxe", "minecraft:diamond_pickaxe", "minecraft:netherite_pickaxe"
        ];

        // 🗡️ Trang bị vũ khí — hỏi xác nhận rồi lưu vào inventory slot 0
        if (item && WEAPON_TYPES.includes(item.typeId)) {
            const newName = item.typeId.replace("minecraft:", "");
            const currentWeaponId = target.getDynamicProperty("gugugaga_weapon");
            const form = new MessageFormData();
            if (currentWeaponId) {
                const oldName = String(currentWeaponId).replace("minecraft:", "");
                form.title("⚔️ Đổi vũ khí");
                form.body(`Gugugaga đang cầm §e${oldName}§r.\n\nBạn muốn đổi sang §e${newName}§r không?`);
                form.button1("✅ Đổi vũ khí");
                form.button2("❌ Hủy");
            } else {
                form.title("⚔️ Trang bị vũ khí");
                form.body(`Bạn muốn trang bị §e${newName}§r cho Gugugaga không?`);
                form.button1("✅ Trang bị");
                form.button2("❌ Hủy");
            }
            form.show(player).then((res) => {
                if (res.canceled || res.selection !== 0) return;
                try {
                    const inv = target.getComponent("minecraft:inventory");
                    if (!inv || !inv.container) return;
                    // Trả vũ khí cũ về túi player
                    const oldItem = inv.container.getItem(0);
                    if (oldItem) {
                        const pInv = player.getComponent("minecraft:inventory");
                        if (pInv && pInv.container) {
                            const leftover = pInv.container.addItem(oldItem);
                            if (leftover) player.dimension.spawnItem(leftover, player.location);
                        } else {
                            player.dimension.spawnItem(oldItem, player.location);
                        }
                        inv.container.setItem(0, undefined);
                    }
                    // Lưu vũ khí mới vào slot 0
                    inv.container.setItem(0, item);
                    // Lấy vũ khí khỏi tay player
                    try {
                        const pInv = player.getComponent("minecraft:inventory");
                        if (pInv && pInv.container) {
                            const slot = player.selectedSlotIndex;
                            const inHand = pInv.container.getItem(slot);
                            if (inHand) {
                                if (inHand.amount > 1) {
                                    inHand.amount--;
                                    pInv.container.setItem(slot, inHand);
                                } else {
                                    pInv.container.setItem(slot, undefined);
                                }
                            }
                        }
                    } catch(e) {}
                    // Đánh dấu có vũ khí + boost damage + visual trên tay
                    target.setDynamicProperty("gugugaga_weapon", item.typeId);
                    try { target.setProperty("gugugaga:has_weapon", true); } catch(e) {}
                    try { target.triggerEvent(`gugugaga:equip_${getWeaponTier(item.typeId)}`); } catch(e) {}
                    try {
                        const eq = target.getComponent("minecraft:equippable");
                        if (eq) eq.setEquipment("Mainhand", item);
                    } catch(e) {}
                    if (currentWeaponId) {
                        player.sendMessage(`§aGugugaga: Đổi sang ${newName} rồi ạ! ⚔️🐧`);
                    } else {
                        player.sendMessage(`§aGugugaga: Đã trang bị ${newName}! ⚔️🐧`);
                    }
                } catch(e) {}
            });
            return;
        }

        if (item && item.typeId === "minecraft:cookie") {

    const health = target.getComponent("minecraft:health");

    if (health) {

        const current = health.currentValue;
        const max = health.effectiveMax;

        if (current < max) {

            health.setCurrentValue(
                Math.min(current + 10, max)
            );

            player.sendMessage(
                `§a🍪 Gugugaga: Nom nom~ Ngon quá! Cảm ơn chủ nha! ❤️ ${Math.min(current + 10, max)}/${max}`
            );

        } else {

            player.sendMessage(
                "§e🐧 Gugugaga: Tớ no rồi nè chủ ơi~ Máu đầy rồi! ❤️"
            );
        }

        hitCounts.delete(target.id);
    }

    return;
}

        system.runTimeout(() => showMainUI(player, target, isSitting), 10);
    }
});

function showMainUI(player, target, isSitting) {
    try {
        const gui = new ActionFormData();
        gui.title("§lQuản lý Gugugaga");
        gui.body("Trạng thái: Sẵn sàng nhận lệnh ạ!\nVui lòng chọn lệnh:");
        const isGuard = target.hasTag("job_guard");
const hpTier = target.hasTag("upgrade_hp_3") ? 3 : target.hasTag("upgrade_hp_2") ? 2 : target.hasTag("upgrade_hp_1") ? 1 : 0;

gui.button("🏠 Bắt đi ngủ", "textures/items/bed_red");
gui.button(isSitting ? "🏃 Cho đi theo chủ" : "🛑 Cho ngồi chờ ở đây", "textures/items/apple");
gui.button("📦 Mở rương đồ", "textures/ui/inventory_icon");
gui.button(isGuard ? "⚔️ Vệ sĩ: BẬT (nhấn để tắt)" : "🐾 Vệ sĩ: TẮT (nhấn để bật)");
gui.button(`💊 Nâng cấp máu [Tier ${hpTier}/3]`);

const weaponId = target.getDynamicProperty("gugugaga_weapon");
if (weaponId) {
    gui.button(`🗡️ Tháo: ${String(weaponId).replace("minecraft:","")}`);
} else {
    gui.button("🗡️ (Chưa trang bị vũ khí)");
}

gui.button("❌ Đóng cửa sổ");

        gui.show(player).then((response) => {
            if (response.canceled) return;
            const isGuard = target.hasTag("job_guard");
const hpTier = target.hasTag("upgrade_hp_3") ? 3 : target.hasTag("upgrade_hp_2") ? 2 : target.hasTag("upgrade_hp_1") ? 1 : 0;

switch (response.selection) {
    case 0:
        target.addTag("is_forced_sleep");
        player.sendMessage("§aGugugaga: Con buồn ngủ rồi ạ! Dẫn con đi tìm giường với nhé, đứng xa là con nhõng nhẽo đó! 🐧💤");
        break;
    case 1:
        if (isSitting) {
            target.removeTag("is_sitting"); target.triggerEvent("gugugaga:follow");
            player.sendMessage("§eGugugaga: Đang lạch bạch đi theo chủ rồi ạ! 🐧✨");
        } else {
            target.addTag("is_sitting"); target.triggerEvent("gugugaga:sit");
            player.sendMessage("§eGugugaga: Ngồi chờ ngoan ở đây rồi ạ! 🐧💖");
        }
        break;
    case 2:
        system.runTimeout(() => showInventoryUI(player, target, isSitting), 5);
        break;
    case 3:
        if (isGuard) {
            target.removeTag("job_guard");
            target.triggerEvent("gugugaga:disable_guard");
            player.sendMessage("§7Gugugaga: Thôi con nghỉ gác rồi ạ~ 🐧");
        } else {
            target.addTag("job_guard");
            target.triggerEvent("gugugaga:enable_guard");
            player.sendMessage("§cGugugaga: Để con bảo vệ chủ! ⚔️🐧");
        }
        // Giữ nguyên damage vũ khí sau khi toggle guard
        try {
            const wId = target.getDynamicProperty("gugugaga_weapon");
            if (wId) target.triggerEvent(`gugugaga:equip_${getWeaponTier(String(wId))}`);
        } catch(e) {}
        break;
        case 4:
        if (hpTier >= 3) {
            player.sendMessage("§eMáu đã nâng cấp tối đa rồi ạ! (80 HP) 🐧💪");
        } else {
            const nextTier = hpTier + 1;
            const hpValues = [40, 60, 80];
            target.removeTag(`upgrade_hp_${hpTier}`);
            target.addTag(`upgrade_hp_${nextTier}`);
            target.triggerEvent(`gugugaga:upgrade_hp_${nextTier}`);
            player.sendMessage(`§aGugugaga: Con mạnh hơn rồi ạ! ❤️ Max HP: ${hpValues[nextTier - 1]} 🐧✨`);
        }
        break;
                case 5: {
        try {
            const inv = target.getComponent("minecraft:inventory");
            if (inv && inv.container) {
                const weapon = inv.container.getItem(0);
                const storedId = target.getDynamicProperty("gugugaga_weapon");
                if (weapon || storedId) {
                    if (weapon) {
                        // Trả vũ khí về túi player, nếu đầy mới drop
                        try {
                            const playerInv = player.getComponent("minecraft:inventory");
                            if (playerInv && playerInv.container) {
                                const leftover = playerInv.container.addItem(weapon);
                                if (leftover) player.dimension.spawnItem(leftover, player.location);
                            } else {
                                player.dimension.spawnItem(weapon, player.location);
                            }
                        } catch(e) {
                            target.dimension.spawnItem(weapon, target.location);
                        }
                        inv.container.setItem(0, undefined);
                    }
                    target.setDynamicProperty("gugugaga_weapon", undefined);
                    try { target.setProperty("gugugaga:has_weapon", false); } catch(e) {}
                    try { target.triggerEvent("gugugaga:unequip_weapon_damage"); } catch(e) {}
                    try {
                        const eq = target.getComponent("minecraft:equippable");
                        if (eq) eq.setEquipment("Mainhand", undefined);
                    } catch(e) {}
                    player.sendMessage("§aGugugaga: Đã tháo vũ khí ra rồi ạ! 🐧🗡️");
                } else {
                    player.sendMessage("§eGugugaga: Con đâu có cầm gì đâu ạ~ 🐧");
                }
            }
        } catch(e) {}
        break;
    }
        case 6:
            // Đóng cửa sổ - không làm gì
            break;
            }
        });
    } catch (e) {}
}

function showInventoryUI(player, target, isSitting) {
    try {
        const inventory = target.getComponent("minecraft:inventory");
        if (!inventory || !inventory.container) return;
        const container = inventory.container;

        const gui = new ActionFormData();
        gui.title("🎒 Túi đồ của Gugugaga");
        gui.body(`Ô trống: ${container.emptySlotsCount} / ${container.size} ô`);

                        let itemsList = [];
        for (let i = 0; i < container.size; i++) {
            const item = container.getItem(i);
            if (item) {
                itemsList.push({ index: i, item: item });
                let itemName = item.typeId.replace("minecraft:", "").toUpperCase();
                gui.button(`📦 ${itemName} (x${item.amount})`);
            }
        }

        gui.button("🛑 Nhả hết đồ xuống đất!");
        gui.button("🔙 Quay lại trang chính");

        gui.show(player).then((response) => {
            if (response.canceled) return;

            // 🌟 Trường hợp 1: Nhả từng món đồ
            if (response.selection < itemsList.length) {
                const selectedItemData = itemsList[response.selection];

                // Gắn tag ngăn hút đồ lại ngay
                target.addTag("is_dropping");

                target.dimension.spawnItem(selectedItemData.item, target.location);
                container.setItem(selectedItemData.index, undefined); 
                player.sendMessage(`§aGugugaga: Phù! Nhả đồ cho chủ rồi ạ! 🐧📦`);

                // Khóa miệng 5 giây (100 ticks) rồi mới cho hút đồ lại
                system.runTimeout(() => { target.removeTag("is_dropping"); }, 100);

                system.runTimeout(() => showInventoryUI(player, target, isSitting), 5);

            // 🌟 Trường hợp 2: Nhả hết đồ
            } else if (response.selection === itemsList.length) {
                let dropped = false;

                // Gắn tag ngăn hút đồ lại ngay
                target.addTag("is_dropping"); 

                                for (let i = 0; i < container.size; i++) {

                    const item = container.getItem(i);
                    if (item) {
                        const dropLoc = {
                            x: target.location.x + (Math.random() - 0.5) * 1,
                            y: target.location.y + 0.5,
                            z: target.location.z + (Math.random() - 0.5) * 1
                        };
                        target.dimension.spawnItem(item, dropLoc);
                        container.setItem(i, undefined);
                        dropped = true;
                    }
                }

                if (dropped) {
                    player.sendMessage("§aGugugaga: Ọe~~ Nhả hết đồ ra rồi ạ, nhẹ bụng ghê! 🐧💨");
                    // Khóa miệng 5 giây
                    system.runTimeout(() => { target.removeTag("is_dropping"); }, 100);
                } else {
                    target.removeTag("is_dropping");
                    player.sendMessage("§eTúi trống rỗng rồi ạ, không có gì để nhả nữa đâu chủ ơi! 🐧✨");
                }

            } else {
                system.runTimeout(() => showMainUI(player, target, isSitting), 5);
            }
        });
    } catch (e) {}
}

// ==========================================
// Hiển thị máu trên đầu Gugugaga
// ==========================================

system.runInterval(() => {

    const overworld = world.getDimension("overworld");

    const penguins = overworld.getEntities({
        type: "custom:gugugaga_penguin"
    });

    for (const penguin of penguins) {

    try {

        const health = penguin.getComponent("minecraft:health");

        if (!health) continue;

        const current = Math.ceil(health.currentValue);
        const max = Math.ceil(health.effectiveMax);

        let job = "";

        if (penguin.hasTag("job_guard")) {
            job = "\n§c⚔️ Vệ sĩ";
        }

        penguin.nameTag =
`§b🐧 Gugugaga
§c❤ ${current}/${max}${job}`;

    } catch (e) {
        // bỏ qua lỗi
    }

}

}, 20);